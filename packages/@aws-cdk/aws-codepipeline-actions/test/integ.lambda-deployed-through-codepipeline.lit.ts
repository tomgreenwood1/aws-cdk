import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import lambda = require('@aws-cdk/aws-lambda');
import cdk = require('@aws-cdk/cdk');
import codepipeline_actions = require('../lib');

const app = new cdk.App();

/// !show
const lambdaStack = new cdk.Stack(app, 'LambdaStack', {
  // remove the Stack from `cdk synth` and `cdk deploy`
  // unless you explicitly filter for it
  autoDeploy: false,
});
const lambdaCode = lambda.Code.cfnParameters();
new lambda.Function(lambdaStack, 'Lambda', {
  code: lambdaCode,
  handler: 'index.handler',
  runtime: lambda.Runtime.NodeJS810,
});
// other resources that your Lambda needs, added to the lambdaStack...

const pipelineStack = new cdk.Stack(app, 'PipelineStack');
const pipeline = new codepipeline.Pipeline(pipelineStack, 'Pipeline');

// add the source code repository containing this code to your Pipeline,
// and the source code of the Lambda Function, if they're separate
const cdkSourceAction = new codepipeline_actions.CodeCommitSourceAction({
  repository: new codecommit.Repository(pipelineStack, 'CdkCodeRepo', { repositoryName: 'CdkCodeRepo'}),
  actionName: 'CdkCode_Source',
});
const lambdaSourceAction = new codepipeline_actions.CodeCommitSourceAction({
  repository: new codecommit.Repository(pipelineStack, 'LambdaCodeRepo', { repositoryName: 'LambdaCodeRepo'}),
  actionName: 'LambdaCode_Source',
});
pipeline.addStage({
  name: 'Source',
  actions: [cdkSourceAction, lambdaSourceAction],
});

// synthesize the Lambda CDK template, using CodeBuild
// the below values are just examples, assuming your CDK code is in TypeScript/JavaScript -
// adjust the build environment and/or commands accordingly
const cdkBuildProject = new codebuild.Project(pipelineStack, 'CdkBuildProject', {
  environment: {
    buildImage: codebuild.LinuxBuildImage.UBUNTU_14_04_NODEJS_10_1_0,
  },
  buildSpec: {
    version: '0.2',
    phases: {
      install: {
        commands: 'npm install',
      },
      build: {
        commands: [
          'npm run build',
          'npm run cdk synth LambdaStack -- -o .',
        ],
      },
    },
    artifacts: {
      files: 'LambdaStack.template.yaml',
    },
  },
});
const cdkBuildAction = new codepipeline_actions.CodeBuildBuildAction({
  actionName: 'CDK_Build',
  project: cdkBuildProject,
  inputArtifact: cdkSourceAction.outputArtifact,
});

// build your Lambda code, using CodeBuild
// again, this example assumes your Lambda is written in TypeScript/JavaScript -
// make sure to adjust the build environment and/or commands if they don't match your specific situation
const lambdaBuildProject = new codebuild.Project(pipelineStack, 'LambdaBuildProject', {
  environment: {
    buildImage: codebuild.LinuxBuildImage.UBUNTU_14_04_NODEJS_10_1_0,
  },
  buildSpec: {
    version: '0.2',
    phases: {
      install: {
        commands: 'npm install',
      },
      build: {
        commands: 'npm run build',
      },
    },
    artifacts: {
      files: [
        'index.js',
        'node_modules/**/*',
      ],
    },
  },
});
const lambdaBuildAction = new codepipeline_actions.CodeBuildBuildAction({
  actionName: 'Lambda_Build',
  project: lambdaBuildProject,
  inputArtifact: lambdaSourceAction.outputArtifact,
});

pipeline.addStage({
  name: 'Build',
  actions: [cdkBuildAction, lambdaBuildAction],
});

// finally, deploy your Lambda Stack
pipeline.addStage({
  name: 'Deploy',
  actions: [
    new codepipeline_actions.CloudFormationCreateUpdateStackAction({
      actionName: 'Lambda_CFN_Deploy',
      templatePath: cdkBuildAction.outputArtifact.atPath('LambdaStack.template.yaml'),
      stackName: 'LambdaStackDeployedName',
      adminPermissions: true,
      parameterOverrides: {
        ...lambdaCode.assign(lambdaBuildAction.outputArtifact.s3Coordinates),
      },
      additionalInputArtifacts: [
        lambdaBuildAction.outputArtifact,
      ],
    }),
  ],
});
