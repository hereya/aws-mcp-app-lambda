import * as cdk from "aws-cdk-lib/core";
import { SecretValue } from "aws-cdk-lib/core";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { Construct } from "constructs";
import * as path from "path";

export class HereyaAwsMcpAppLambdaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const hereyaProjectRootDir = process.env["hereyaProjectRootDir"];
    if (!hereyaProjectRootDir) {
      throw new Error("hereyaProjectRootDir environment variable is required");
    }

    const oauthServerUrl = process.env["oauthServerUrl"];
    if (!oauthServerUrl) {
      throw new Error("oauthServerUrl environment variable is required");
    }

    const organizationId = process.env["organizationId"];
    if (!organizationId) {
      throw new Error("organizationId environment variable is required");
    }

    const memorySize = process.env["memorySize"]
      ? parseInt(process.env["memorySize"])
      : 256;
    const timeout = process.env["timeout"]
      ? parseInt(process.env["timeout"])
      : 30;
    const handlerName = process.env["handler"] ?? "handler.handler";
    const customDomain = process.env["customDomain"];
    const customDomainZone =
      process.env["customDomainZone"] ?? extractDomainZone(customDomain);
    const wildcardCertificateArn = process.env["wildcardCertificateArn"];

    // Parse hereyaProjectEnv
    const env: Record<string, string> = JSON.parse(
      process.env["hereyaProjectEnv"] ?? "{}"
    );

    // Separate IAM policy env vars
    const policyEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => key.startsWith("IAM_POLICY_") || key.startsWith("iamPolicy")
      )
    );

    const nonPolicyEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !key.startsWith("IAM_POLICY_") && !key.startsWith("iamPolicy")
      )
    );

    // Separate secret env vars (secret:// prefix)
    const secretEnvEntries = Object.entries(nonPolicyEnv)
      .filter(([, value]) => (value as string).startsWith("secret://"))
      .map(([key, value]) => {
        const plainValue = (value as string).split("secret://")[1];
        const secretName = `/${this.stackName}/${key}`;
        const secret = new secrets.Secret(this, key, {
          secretName,
          secretStringValue: SecretValue.unsafePlainText(plainValue),
        });
        return { key, secret, secretName };
      });

    const plainEnv: Record<string, string> = Object.fromEntries(
      Object.entries(nonPolicyEnv).filter(
        ([, value]) => !(value as string).startsWith("secret://")
      )
    );

    // Lambda function
    const fn = new lambda.Function(this, "Handler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: handlerName,
      code: lambda.Code.fromAsset(path.join(hereyaProjectRootDir, "dist")),
      memorySize,
      timeout: cdk.Duration.seconds(timeout),
      environment: plainEnv,
    });

    // Attach secret references (secret name, not value) and grant read access
    const secretKeys: string[] = [];
    for (const { key, secret, secretName } of secretEnvEntries) {
      fn.addEnvironment(key, secretName);
      secret.grantRead(fn);
      secretKeys.push(key);
    }
    if (secretKeys.length > 0) {
      fn.addEnvironment("SECRET_KEYS", secretKeys.join(","));
    }

    // Attach IAM policies from dependency packages
    for (const [, value] of Object.entries(policyEnv)) {
      const policy = JSON.parse(value as string);
      for (const statement of policy.Statement) {
        fn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
      }
    }

    // Authorizer Lambda for JWT validation + org check
    const authorizerFn = new lambda.Function(this, "AuthorizerHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "authorizer")),
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OAUTH_SERVER_URL: oauthServerUrl,
        BOUND_ORG_ID: organizationId,
      },
    });

    const httpAuthorizer = new authorizers.HttpLambdaAuthorizer(
      "HereyaAuthorizer",
      authorizerFn,
      {
        responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
        resultsCacheTtl: cdk.Duration.minutes(5),
      }
    );

    // HTTP API
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: this.stackName,
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "LambdaIntegration",
      fn
    );

    httpApi.addRoutes({
      path: "/mcp",
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: httpAuthorizer,
    });

    // Custom domain
    if (customDomain && customDomainZone) {
      if (!wildcardCertificateArn) {
        throw new Error(
          "wildcardCertificateArn is required when customDomain is set"
        );
      }

      const certificate = acm.Certificate.fromCertificateArn(
        this,
        "Certificate",
        wildcardCertificateArn
      );

      const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomainZone,
      });

      const domainName = new apigwv2.DomainName(this, "DomainName", {
        domainName: customDomain,
        certificate,
      });

      new apigwv2.ApiMapping(this, "ApiMapping", {
        api: httpApi,
        domainName,
      });

      new route53.ARecord(this, "AliasRecord", {
        zone: hostedZone,
        recordName: customDomain,
        target: route53.RecordTarget.fromAlias(
          new targets.ApiGatewayv2DomainProperties(
            domainName.regionalDomainName,
            domainName.regionalHostedZoneId
          )
        ),
      });

      new cdk.CfnOutput(this, "ServiceUrl", {
        value: `https://${customDomain}`,
      });
    } else {
      new cdk.CfnOutput(this, "ServiceUrl", {
        value: httpApi.apiEndpoint,
      });
    }
  }
}

function extractDomainZone(
  customDomain: string | undefined
): string | undefined {
  if (!customDomain) return undefined;
  const parts = customDomain.split(".");
  if (parts.length < 2) throw new Error("Invalid domain name: " + customDomain);
  return parts.length === 2 ? customDomain : parts.slice(1).join(".");
}
