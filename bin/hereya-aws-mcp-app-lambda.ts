#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { HereyaAwsMcpAppLambdaStack } from "../lib/hereya-aws-mcp-app-lambda-stack";

const app = new cdk.App();
new HereyaAwsMcpAppLambdaStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
