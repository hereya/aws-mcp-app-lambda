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
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
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


    // Cognito config (from aws/cognito package outputs via hereyaProjectEnv)
    const cognitoUserPoolId = plainEnv["userPoolId"] ?? nonPolicyEnv["userPoolId"];
    const cognitoClientId = plainEnv["userPoolClientId"] ?? nonPolicyEnv["userPoolClientId"];
    const cognitoRegion = plainEnv["awsCognitoRegion"] ?? nonPolicyEnv["awsCognitoRegion"] ?? process.env["CDK_DEFAULT_REGION"] ?? "us-east-1";

    // -----------------------------------------------------------------------
    // Lambda 1: App Handler (Org Lambda — MCP + frontend routes)
    // -----------------------------------------------------------------------

    // Pass deploy-time config vars to the handler (not in hereyaProjectEnv)
    if (customDomain) {
      plainEnv["customDomain"] = customDomain;
    }

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

    // -----------------------------------------------------------------------
    // MCP OAuth Authorizer Lambda
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // HTTP API
    // -----------------------------------------------------------------------

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: this.stackName,
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "LambdaIntegration",
      fn
    );

    // Compute service URL for PRM (custom domain or API endpoint)
    const serviceUrl = customDomain
      ? `https://${customDomain}`
      : httpApi.apiEndpoint;

    // -----------------------------------------------------------------------
    // Protected Resource Metadata (RFC 9728)
    // -----------------------------------------------------------------------

    const prmLambda = new lambda.Function(this, "PrmHandler", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        exports.handler = async () => ({
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            resource: process.env.SERVICE_URL + "/mcp",
            authorization_servers: [process.env.OAUTH_SERVER_URL + "/oauth/" + process.env.ORGANIZATION_ID],
            bearer_methods_supported: ["header"],
            scopes_supported: ["mcp:access"],
          }),
        });
      `),
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      environment: {
        SERVICE_URL: serviceUrl,
        OAUTH_SERVER_URL: oauthServerUrl,
        ORGANIZATION_ID: organizationId,
      },
    });

    httpApi.addRoutes({
      path: "/.well-known/oauth-protected-resource",
      methods: [apigwv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "PrmIntegration",
        prmLambda
      ),
    });

    // MCP route (existing)
    httpApi.addRoutes({
      path: "/mcp",
      methods: [apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
      authorizer: httpAuthorizer,
    });

    // -----------------------------------------------------------------------
    // Frontend Authorizer Lambda (Cognito JWT cookie validation)
    // -----------------------------------------------------------------------

    let frontendAuthorizer: authorizers.HttpLambdaAuthorizer | undefined;

    if (cognitoUserPoolId && cognitoClientId) {
      const frontendAuthorizerFn = new lambda.Function(
        this,
        "FrontendAuthorizerHandler",
        {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: "index.handler",
          code: lambda.Code.fromAsset(
            path.join(__dirname, "frontend-authorizer")
          ),
          memorySize: 128,
          timeout: cdk.Duration.seconds(10),
          environment: {
            COGNITO_USER_POOL_ID: cognitoUserPoolId,
            COGNITO_REGION: cognitoRegion,
          },
        }
      );

      frontendAuthorizer = new authorizers.HttpLambdaAuthorizer(
        "FrontendAuthorizer",
        frontendAuthorizerFn,
        {
          responseTypes: [authorizers.HttpLambdaResponseType.SIMPLE],
          resultsCacheTtl: cdk.Duration.seconds(0), // No caching — cookie-based
          identitySource: [], // No identity source — always invoke authorizer (supports public endpoints without cookies)
        }
      );

      // -------------------------------------------------------------------
      // Auth Lambda (login/OTP/verify/logout)
      // -------------------------------------------------------------------

      const authLambdaEnv: Record<string, string> = {
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
        COGNITO_CLIENT_ID: cognitoClientId,
        COGNITO_REGION: cognitoRegion,
        CUSTOM_DOMAIN: customDomain ?? "",
      };

      const authLambdaFn = new lambda.Function(this, "AuthLambdaHandler", {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname, "auth-lambda")),
        memorySize: 128,
        timeout: cdk.Duration.seconds(15),
        environment: authLambdaEnv,
      });

      // Grant Auth Lambda access to all secrets from hereyaProjectEnv
      // (same secrets already created for the main handler — reuse them)
      const authSecretKeys: string[] = [];
      for (const { key, secret, secretName } of secretEnvEntries) {
        authLambdaFn.addEnvironment(key, secretName);
        secret.grantRead(authLambdaFn);
        authSecretKeys.push(key);
      }
      if (authSecretKeys.length > 0) {
        authLambdaFn.addEnvironment("SECRET_KEYS", authSecretKeys.join(","));
      }

      // Grant Auth Lambda Cognito permissions (same IAM policies as main handler)
      for (const [, value] of Object.entries(policyEnv)) {
        const policy = JSON.parse(value as string);
        for (const statement of policy.Statement) {
          authLambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
        }
      }

      const authLambdaIntegration = new integrations.HttpLambdaIntegration(
        "AuthLambdaIntegration",
        authLambdaFn
      );

      // Auth routes (no authorizer — always accessible)
      httpApi.addRoutes({
        path: "/{app}/auth/{proxy+}",
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration: authLambdaIntegration,
      });

      // Frontend routes (with Frontend Authorizer → Org Lambda)
      const frontendRoutePatterns = [
        "/{app}/view/{proxy+}",
        "/{app}/data/{proxy+}",
        "/{app}/action/{proxy+}",
        "/{app}/form/{proxy+}",
      ];

      for (const routePath of frontendRoutePatterns) {
        httpApi.addRoutes({
          path: routePath,
          methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
          integration: lambdaIntegration,
          authorizer: frontendAuthorizer,
        });
      }

      // Catch-all for unmatched frontend paths (e.g., /{app}/ root)
      // More specific routes above take priority in API Gateway HTTP API
      httpApi.addRoutes({
        path: "/{proxy+}",
        methods: [apigwv2.HttpMethod.GET],
        integration: lambdaIntegration,
        authorizer: frontendAuthorizer,
      });
    }

    // -----------------------------------------------------------------------
    // Custom domain + DNS
    // -----------------------------------------------------------------------

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

      // API Gateway custom domain for MCP (exact domain)
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

      // -------------------------------------------------------------------
      // CloudFront distribution for frontend (*.{customDomain})
      // CloudFront REQUIRES ACM certificates in us-east-1, regardless of
      // which region this stack is deployed to. We auto-create one via
      // DnsValidatedCertificate which provisions it in us-east-1 with
      // DNS validation through the same hosted zone.
      // -------------------------------------------------------------------

      if (cognitoUserPoolId && cognitoClientId) {
        const cloudfrontCertificate = new acm.DnsValidatedCertificate(
          this,
          "CloudFrontCertificate",
          {
            domainName: `*.${customDomain}`,
            hostedZone,
            region: "us-east-1",
          }
        );

        // CloudFront Function: extract app subdomain → prepend to path
        const cfFunction = new cloudfront.Function(this, "SubdomainRewrite", {
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var host = request.headers.host.value;
  var customDomain = '${customDomain}';
  if (host !== customDomain && host.endsWith('.' + customDomain)) {
    var appName = host.slice(0, -(customDomain.length + 1));
    request.uri = '/' + appName + request.uri;
  }
  return request;
}
          `),
          functionName: `${this.stackName}-subdomain-rewrite`,
        });

        // API Gateway origin
        const apiDomainName = cdk.Fn.select(
          2,
          cdk.Fn.split("/", httpApi.apiEndpoint)
        ); // extract domain from https://xxx.execute-api...

        const distribution = new cloudfront.Distribution(
          this,
          "FrontendDistribution",
          {
            certificate: cloudfrontCertificate,
            domainNames: [`*.${customDomain}`],
            defaultBehavior: {
              origin: new origins.HttpOrigin(apiDomainName, {
                protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
              }),
              viewerProtocolPolicy:
                cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
              cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
              originRequestPolicy: new cloudfront.OriginRequestPolicy(
                this,
                "FrontendOriginPolicy",
                {
                  cookieBehavior:
                    cloudfront.OriginRequestCookieBehavior.allowList(
                      "hereya_id_token"
                    ),
                  headerBehavior:
                    cloudfront.OriginRequestHeaderBehavior.allowList(
                      "Content-Type"
                    ),
                  queryStringBehavior:
                    cloudfront.OriginRequestQueryStringBehavior.all(),
                }
              ),
              functionAssociations: [
                {
                  function: cfFunction,
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                },
              ],
            },
          }
        );

        // Route53 wildcard → CloudFront
        new route53.ARecord(this, "WildcardAliasRecord", {
          zone: hostedZone,
          recordName: `*.${customDomain}`,
          target: route53.RecordTarget.fromAlias(
            new targets.CloudFrontTarget(distribution)
          ),
        });

        new cdk.CfnOutput(this, "FrontendDistributionDomain", {
          value: distribution.distributionDomainName,
        });
      }

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
