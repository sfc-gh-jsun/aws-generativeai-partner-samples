import { Construct } from "constructs";
import { Stream, StreamMode } from "aws-cdk-lib/aws-kinesis";
import { CustomResource, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { join as pathJoin } from "path";
import { Code as LambdaCode, Function, Runtime as LambdaRuntime } from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { CfnApplication } from "aws-cdk-lib/aws-kinesisanalyticsv2";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as firehose from "aws-cdk-lib/aws-kinesisfirehose";
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';

export interface MainStackProps extends StackProps {
    kinesisStreamName: string;
    flinkAppName: string;
    snowflakeConnection?: SnowflakeStackProps;
}

interface SnowflakeStackProps {
    snowflakeAccountUrl: string;
    snowflakeSecretName: string;
    snowflakeDatabase: string;
    snowflakeSchema: string;
    snowflakeTable: string;
    firehoseStreamName: string;
}

interface FlinkApplicationProperties {
    REGION: string;
    INPUT_STREAM_NAME: string;
    [key: string]: string;
}

export class MainStack extends Stack {

    constructor(scope: Construct, id: string, props: MainStackProps) {
        super(scope, id, props);

    // Lambda function to generate key pair using Node.js crypto
    const keyGenFunction = new lambda.Function(this, 'KeyGenFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(`
const crypto = require('crypto');

exports.handler = async (event, context) => {
    console.log('Event:', JSON.stringify(event));

    const requestType = event.RequestType || '';

    if (requestType === 'Delete') {
        return {
            PhysicalResourceId: 'key-generator',
            Data: {}
        };
    }

    try {
        const passphrase = event.ResourceProperties?.Passphrase || 'snowflake';

        // Generate RSA key pair
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
                cipher: 'aes-256-cbc',
                passphrase: passphrase
            }
        });

        // Strip header/footer and newlines
        const stripPem = (pem) =>
            pem
                .replace(/-----BEGIN [^-]+-----/, '')
                .replace(/-----END [^-]+-----/, '')
                .replace(/\\r?\\n|\\s+/g, '');

        const privateKeyStripped = stripPem(privateKey);
        const publicKeyStripped = stripPem(publicKey);

        return {
            PhysicalResourceId: 'key-generator',
            Data: {
                PrivateKey: privateKeyStripped,
                PublicKey: publicKeyStripped,
                Passphrase: passphrase
            }
        };

    } catch (error) {
        console.error('Error:', error);
        throw new Error('Key generation failed: ' + error.message);
    }
};
`),
    });

    // Add permissions for the Lambda function
    keyGenFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents'
      ],
      resources: ['*']
    }));

    // Custom resource to trigger key generation
    const keyGenProvider = new cr.Provider(this, 'KeyGenProvider', {
      onEventHandler: keyGenFunction,
    });

    const keyGenResource = new cdk.CustomResource(this, 'KeyGenResource', {
      serviceToken: keyGenProvider.serviceToken,
      properties: {
        Passphrase: 'snowflake', // You can make this configurable
        Timestamp: Date.now() // Force update on each deployment if needed
      }
    });

    // Secret Manager ADF keypair Credentials
    const secret_prefix = 'ADF_';

    // Create the secret with generated key pair
    const secret = new secretsmanager.Secret(this, 'ADFSecret', {
      secretName: secret_prefix + 'secret',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          user: 'adf_pl_user',
          // user: 'GCP_STREAMING_USER',
          private_key: keyGenResource.getAttString('PrivateKey'),
          key_passphrase: keyGenResource.getAttString('Passphrase'),
          public_key: keyGenResource.getAttString('PublicKey') // Added public key for completeness
        })
      ),
      // encryptionKey: smkey,
    });

    // Make sure secret depends on key generation
    secret.node.addDependency(keyGenResource);

    new cdk.CfnOutput(this, 'ADFSecretName', {
      value: secret.secretName,
      description: 'The ADF Secret Name',
    });

    new cdk.CfnOutput(this, 'GeneratedPublicKey', {
      value: keyGenResource.getAttString('PublicKey'),
      description: 'Generated Public Key (Base64 encoded)',
    });


        // Create bucket to upload flink application
        const flinkAsset = new Asset(this, "FlinkAsset", {
            path: pathJoin(__dirname, "../../flink-async-bedrock/target/flink-async-bedrock-0.1.jar"),
        });

        // Create a Kinesis Data Stream
        const stream = new Stream(this, "KinesisStream", {
            streamMode: StreamMode.ON_DEMAND,
            streamName: props.kinesisStreamName,
            removalPolicy: RemovalPolicy.DESTROY
        });

        // Create IAM role for kinesis data analytics application
        const flinkRole = new Role(this, "FlinkRole", {
            assumedBy: new ServicePrincipal("kinesisanalytics.amazonaws.com"),
        });

        const bucketArnString = `arn:aws:s3:::${flinkAsset.s3BucketName}`;

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "s3:GetObject",
                "s3:GetObjectVersion"
            ],
            resources: [`${bucketArnString}/${flinkAsset.s3ObjectKey}`]
        }))

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "kinesis:DescribeStream",
                "kinesis:GetShardIterator",
                "kinesis:GetRecords",
                "kinesis:PutRecord",
                "kinesis:PutRecords",
                "kinesis:ListShards"
            ],
            resources: [`arn:aws:kinesis:${this.region}:${this.account}:stream/${props.kinesisStreamName}`]

        }))

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "bedrock:InvokeModel"
            ],
            resources: [`arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`]
        }))

        // // Create the VPC where MFA will reside
        // const vpc = new Vpc(this, "StreamingVPC", {
        //     maxAzs: 2,
        //     vpcName: "StreamingVPC",
        // });

        const vpc = ec2.Vpc.fromLookup(this, 'ExistingVPC', {
        vpcId: 'vpc-02429af2ce37334c8' // OR use tags like `isDefault: true`
        // Or use: `tags: { Name: 'MyVpcName' }`
        });

        flinkRole.addToPolicy(new PolicyStatement({
            actions: [
                "ec2:DescribeVpcs",
                "ec2:DescribeSubnets",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeDhcpOptions",
                "ec2:DescribeNetworkInterfaces",
                "ec2:CreateNetworkInterface",
                "ec2:CreateNetworkInterfacePermission",
                "ec2:DeleteNetworkInterface",
                "ec2:DescribeVpcs"
            ],
            resources: ["*"]
        }))

        // Create security group for Flink application
        const flinkSecurityGroup = new SecurityGroup(this, "FlinkSecurityGroup", {
            vpc: vpc,
            allowAllOutbound: true,
            securityGroupName: "FlinkSecurityGroup",
        });

        const kinesisVpcEndpointSecurityGroup = new SecurityGroup(this, "KinesisVpcEndpointSecurityGroup", {
            vpc: vpc, allowAllOutbound: true, securityGroupName: "KinesisVpcEndpointSecurityGroup",
        });

        const createFirehoseStream = () => {
            const snowProps = props.snowflakeConnection!
            const secret = sm.Secret.fromSecretNameV2(this, 'SnowflakeSecret', snowProps.snowflakeSecretName);

            const bucket = new s3.Bucket(this, 'FirehoseBucket', {
                removalPolicy: RemovalPolicy.DESTROY,
                autoDeleteObjects: true
            });

            // CloudWatch Logs
            const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogs', {
                retention: logs.RetentionDays.ONE_WEEK
            });
            const firehoseLogStream = new logs.LogStream(this, 'FirehoseLogsStream', {
                logGroup: firehoseLogGroup,
                removalPolicy: RemovalPolicy.DESTROY
            })

            // IAM role for Firehose delivery to S3 and Snowflake
            const firehoseRole = new iam.Role(this, 'FirehoseRole', {
                assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
            })
            bucket.grantReadWrite(firehoseRole)
            secret.grantRead(firehoseRole)
            firehoseLogGroup.grantWrite(firehoseRole)

            const hose = new firehose.CfnDeliveryStream(this, 'FirehoseDeliveryStream', {
                deliveryStreamType: 'DirectPut',
                deliveryStreamName: snowProps.firehoseStreamName,
                snowflakeDestinationConfiguration: {
                    secretsManagerConfiguration: {
                        secretArn: secret.secretArn,
                        enabled: true
                    },
                    s3Configuration: {
                        bucketArn: bucket.bucketArn,
                        roleArn: firehoseRole.roleArn
                    },
                    database: snowProps.snowflakeDatabase,
                    table: snowProps.snowflakeTable,
                    schema: snowProps.snowflakeSchema,
                    accountUrl: snowProps.snowflakeAccountUrl,
                    roleArn: firehoseRole.roleArn,
                    dataLoadingOption: 'JSON_MAPPING',
                    cloudWatchLoggingOptions: {
                        enabled: true,
                        logGroupName: firehoseLogGroup.logGroupName,
                        logStreamName: firehoseLogStream.logStreamName
                    }
                }
            });

            hose.node.addDependency(firehoseRole);

            // Create a default S3 destination Firehose if no Snowflake configuration is provided
            const defaultFirehoseStream = new firehose.CfnDeliveryStream(this, 'DefaultFirehoseDeliveryStream', {
                deliveryStreamType: 'DirectPut',
                deliveryStreamName: 'default-reviews-delivery-stream',
                s3DestinationConfiguration: {
                    bucketArn: bucket.bucketArn,
                    roleArn: firehoseRole.roleArn,
                    bufferingHints: {
                        intervalInSeconds: 60,
                        sizeInMBs: 5
                    },
                    cloudWatchLoggingOptions: {
                        enabled: true,
                        logGroupName: firehoseLogGroup.logGroupName,
                        logStreamName: firehoseLogStream.logStreamName
                    }
                }
            });

            defaultFirehoseStream.node.addDependency(firehoseRole);

            return {
                snowflakeFirehose: hose,
                defaultFirehose: defaultFirehoseStream,
                firehoseRole: firehoseRole
            };
        }

        const flinkApplicationProperties: FlinkApplicationProperties = {
            "REGION": this.region,
            "INPUT_STREAM_NAME": props.kinesisStreamName
        }

        // Create Firehose stream regardless of Snowflake connection
        const firehoseResources = createFirehoseStream();

        if (props.snowflakeConnection) {
            flinkApplicationProperties["FIREHOSE_DELIVERY_STREAM"] = props.snowflakeConnection.firehoseStreamName;
        } else {
            flinkApplicationProperties["FIREHOSE_DELIVERY_STREAM"] = 'default-reviews-delivery-stream';
        }

        // Add Firehose permissions to Flink role
        flinkRole.addToPolicy(
            new PolicyStatement({
                actions: [
                    "firehose:PutRecord",
                    "firehose:PutRecordBatch"
                ],
                resources: [`arn:aws:firehose:${this.region}:${this.account}:deliverystream/*`]
            })
        );
        const flinkApplication = new CfnApplication(
            this,
            "FlinkApplication", {
            applicationConfiguration: {
                applicationCodeConfiguration: {
                    codeContent: {
                        s3ContentLocation: {
                            bucketArn: bucketArnString,
                            fileKey: flinkAsset.s3ObjectKey
                        }
                    },
                    codeContentType: "ZIPFILE"
                },
                flinkApplicationConfiguration: {
                    checkpointConfiguration: {
                        configurationType: "CUSTOM",
                        checkpointingEnabled: true,
                        checkpointInterval: 60000,
                    }
                },
                environmentProperties: {
                    propertyGroups: [
                        {
                            propertyGroupId: "FlinkApplicationProperties",
                            propertyMap: flinkApplicationProperties
                        }
                    ]
                },
                vpcConfigurations: [
                    {
                        subnetIds: vpc.selectSubnets({
                            subnetType: SubnetType.PRIVATE_WITH_EGRESS,
                        }).subnetIds,
                        securityGroupIds: [flinkSecurityGroup.securityGroupId],
                    },
                ]
            },
            applicationName: props.flinkAppName,
            runtimeEnvironment: "FLINK-1_18",
            serviceExecutionRole: flinkRole.roleArn,
        }
        );

        flinkApplication.node.addDependency(flinkAsset);
        flinkApplication.node.addDependency(flinkRole);

        const startFlinkApplicationHandler = new Function(this, "startFlinkApplicationHandler", {
            runtime: LambdaRuntime.PYTHON_3_12,
            code: LambdaCode.fromAsset(pathJoin(__dirname, "../customResources/startFlinkApplication")),
            handler: "index.on_event",
            timeout: Duration.minutes(14),
            memorySize: 512
        })

        const startFlinkApplicationProvider = new Provider(this, "startFlinkApplicationProvider", {
            onEventHandler: startFlinkApplicationHandler,
            logRetention: RetentionDays.ONE_WEEK
        })

        startFlinkApplicationHandler.addToRolePolicy(new PolicyStatement({
            actions: [
                "kinesisanalytics:DescribeApplication",
                "kinesisanalytics:StartApplication",
                "kinesisanalytics:StopApplication",

            ],
            resources: [`arn:aws:kinesisanalytics:${this.region}:${this.account}:application/${props.flinkAppName}`]
        }))

        const startFlinkApplicationResource = new CustomResource(this, "startFlinkApplicationResource", {
            serviceToken: startFlinkApplicationProvider.serviceToken,
            properties: {
                AppName: props.flinkAppName,
            }
        })

        startFlinkApplicationResource.node.addDependency(flinkApplication);

    }
}
