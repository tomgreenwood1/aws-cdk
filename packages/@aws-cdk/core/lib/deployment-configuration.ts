import * as asset_schema from '@aws-cdk/cdk-assets-schema';
import * as cxschema from '@aws-cdk/cloud-assembly-schema';
import * as cxapi from '@aws-cdk/cx-api';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DockerImageAssetLocation, DockerImageAssetSource, FileAssetLocation, FileAssetPackaging, FileAssetSource } from './assets';
import { Fn } from './cfn-fn';
import { Construct, ConstructNode, IConstruct, ISynthesisSession } from './construct-compat';
import { FileAssetParameters } from './private/asset-parameters';
import { Stack } from './stack';
import { Token } from './token';

/**
 * The well-known name for the docker image asset ECR repository. All docker
 * image assets will be pushed into this repository with an image tag based on
 * the source hash.
 */
const ASSETS_ECR_REPOSITORY_NAME = 'aws-cdk/assets';

/**
 * This allows users to work around the fact that the ECR repository is
 * (currently) not configurable by setting this context key to their desired
 * repository name. The CLI will auto-create this ECR repository if it's not
 * already created.
 */
const ASSETS_ECR_REPOSITORY_NAME_OVERRIDE_CONTEXT_KEY = 'assets-ecr-repository-name';

/**
 * Encodes information how a certain Stack should be deployed
 */
export interface IDeploymentConfiguration {
  /**
   * Bind to the stack this environment is going to be used on
   *
   * Must be called before any of the other methods are called.
   */
  bind(stack: Stack): void;

  /**
   * Register a File Asset
   *
   * Returns the parameters that can be used to refer to the asset inside the template.
   */
  addFileAsset(asset: FileAssetSource): FileAssetLocation;

  /**
   * Register a Docker Image Asset
   *
   * Returns the parameters that can be used to refer to the asset inside the template.
   */
  addDockerImageAsset(asset: DockerImageAssetSource): DockerImageAssetLocation;

  /**
   * Synthesize all artifacts required for the stack into the session
   *
   * @experimental
   */
  writeStackArtifacts(session: ISynthesisSession): void;
}

/**
 * Result of synthesis
 */
export interface DeploymentConfigurationSynthesisResult {
  /**
   * Artifact names that got generated that the stack should depend on
   *
   * @default - No additional dependencies
   */
  readonly additionalStackDependencies?: string[];
}

/**
 * Configuration necessary for deploying the stack
 */
export interface StackDeploymentConfig {
  /**
   * The role that needs to be assumed to deploy the stack
   *
   * @default - No role is assumed (current credentials are used)
   */
  readonly assumeRoleArn?: string;

  /**
   * The role that is passed to CloudFormation to execute the change set
   *
   * @default - No role is passed (current role/credentials are used)
   */
  readonly cloudFormationExecutionRoleArn?: string;
}

/**
 * Configuration properties for DefaultDeploymentConfiguration
 */
export interface DefaultDeploymentConfigurationProps {
  /**
   * Name of the staging bucket
   *
   * You must supply this if you have given a non-standard name to the staging bucket.
   *
   * The placeholders `${Qualifier}`, `${AWS::AccountId}` and `${AWS::Region}` will
   * be replaced with the values of qualifier and the stack's account and region,
   * respectively.
   *
   * @default 'cdk-bootstrap-${Qualifier}-assets-${AWS::AccountId}-${AWS::Region}'
   */
  readonly stagingBucketName?: string;

  /**
   * Name of the ECR repository to push Docker Images
   *
   * You must supply this if you have given a non-standard name to the ECR repository.
   *
   * The placeholders `${Qualifier}`, `${AWS::AccountId}` and `${AWS::Region}` will
   * be replaced with the values of qualifier and the stack's account and region,
   * respectively.
   *
   * @default 'cdk-bootstrap-${Qualifier}-container-assets-${AWS::AccountId}-${AWS::Region}'
   */
  readonly ecrRepositoryName?: string;

  /**
   * The role to use to publish assets to this environment
   *
   * You must supply this if you have given a non-standard name to the publishing role.
   *
   * The placeholders `${Qualifier}`, `${AWS::AccountId}` and `${AWS::Region}` will
   * be replaced with the values of qualifier and the stack's account and region,
   * respectively.
   *
   * @default 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-bootstrap-publishing-role-${AWS::AccountId}-${AWS::Region}'
   */
  readonly assetPublishingRoleArn?: string;

  /**
   * External ID to use when assuming role for asset publishing
   *
   * @default - No external ID
   */
  readonly assetPublishingExternalId?: string;

  /**
   * The role to assume to initiate a deployment in this environment
   *
   * You must supply this if you have given a non-standard name to the publishing role.
   *
   * The placeholders `${Qualifier}`, `${AWS::AccountId}` and `${AWS::Region}` will
   * be replaced with the values of qualifier and the stack's account and region,
   * respectively.
   *
   * @default 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-bootstrap-deploy-action-role-${AWS::AccountId}-${AWS::Region}'
   */
  readonly deployActionRoleArn?: string;

  /**
   * The role CloudFormation will assume when deploying the Stack
   *
   * You must supply this if you have given a non-standard name to the execution role.
   *
   * The placeholders `${Qualifier}`, `${AWS::AccountId}` and `${AWS::Region}` will
   * be replaced with the values of qualifier and the stack's account and region,
   * respectively.
   *
   * @default 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-bootstrap-cfn-exec-role-${AWS::AccountId}-${AWS::Region}'
   */
  readonly cloudFormationExecutionRole?: string;

  /**
   * Qualifier to disambiguate multiple environments in the same account
   *
   * You can use this and leave the other naming properties empty if you have deployed
   * the bootstrap environment with standard names but only differnet qualifiers.
   *
   * @default 'hnb659fds'
   */
  readonly qualifier?: string;
}

/**
 * Uses conventionally named roles and reify asset storage locations
 *
 * This DeploymentConfiguration is the only DeploymentConfiguration that generates
 * an asset manifest, and is required to deploy CDK applications using the
 * `@aws-cdk/app-delivery` CI/CD library.
 *
 * Requires the environment to have been bootstrapped with Bootstrap Stack V2.
 */
export class DefaultDeploymentConfiguration implements IDeploymentConfiguration {
  private stack!: Stack;
  private bucketName!: string;
  private repositoryName!: string;
  private deployActionRoleArn!: string;
  private cloudFormationExecutionRoleArn!: string;
  private assetPublishingRoleArn!: string;

  private readonly assets: asset_schema.ManifestFile = {
    version: asset_schema.AssetManifestSchema.currentVersion(),
    files: {},
    dockerImages: {},
  };

  constructor(private readonly props: DefaultDeploymentConfigurationProps = {}) {
  }

  public bind(stack: Stack): void {
    this.stack = stack;

    const qualifier = this.props.qualifier ?? 'hnb659fds';

    // Function to replace placeholders in the input string as much as possible
    //
    // We replace:
    // - ${Qualifier}: always
    // - ${AWS::AccountId}, ${AWS::Region}: only if we have the actual values available
    // - ${AWS::Partition}: never, since we never have the actual partition value.
    const specialize = (s: string) => {
      s = replaceAll(s, '${Qualifier}', qualifier);
      return cxapi.EnvironmentPlaceholders.replace(s, {
        region: resolvedOr(this.stack.region, cxapi.EnvironmentPlaceholders.CURRENT_REGION),
        accountId: resolvedOr(this.stack.account, cxapi.EnvironmentPlaceholders.CURRENT_ACCOUNT),
        partition: cxapi.EnvironmentPlaceholders.CURRENT_PARTITION,
      });
    };

    // tslint:disable:max-line-length
    this.bucketName = specialize(this.props.stagingBucketName ?? 'cdk-bootstrap-${Qualifier}-assets-${AWS::AccountId}-${AWS::Region}');
    this.repositoryName = specialize(this.props.ecrRepositoryName ?? 'cdk-bootstrap-${Qualifier}-container-assets-${AWS::AccountId}-${AWS::Region}');
    this.deployActionRoleArn = specialize(this.props.deployActionRoleArn ?? 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-bootstrap-deploy-action-role-${AWS::AccountId}-${AWS::Region}');
    this.cloudFormationExecutionRoleArn = specialize(this.props.cloudFormationExecutionRole ?? 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-bootstrap-cfn-exec-role-${AWS::AccountId}-${AWS::Region}');
    this.assetPublishingRoleArn = specialize(this.props.assetPublishingRoleArn ?? 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-bootstrap-publishing-role-${AWS::AccountId}-${AWS::Region}');
    // tslint:enable:max-line-length
  }

  public addFileAsset(asset: FileAssetSource): FileAssetLocation {
    const objectKey = asset.sourceHash + '.zip';

    // Add to manifest
    this.assets.files![asset.sourceHash] = {
      source: {
        path: asset.fileName,
        packaging: asset.packaging
      },
      destinations: {
        [this.manifestEnvName]: {
          bucketName: this.bucketName,
          objectKey,
          region: resolvedOr(this.stack.region, undefined),
          assumeRoleArn: this.assetPublishingRoleArn,
          assumeRoleExternalId: this.props.assetPublishingExternalId,
        }
      },
    };

    // Return CFN expression
    const bucketName = this.cfnify(this.bucketName);
    return {
      bucketName,
      objectKey,
      s3Url: `https://s3.${this.stack.region}.${this.stack.urlSuffix}/${bucketName}/${objectKey}`,
    };
  }

  public addDockerImageAsset(asset: DockerImageAssetSource): DockerImageAssetLocation {
    const imageTag = asset.sourceHash;

    // Add to manifest
    this.assets.dockerImages![asset.sourceHash] = {
      source: {
        directory: asset.directoryName,
        dockerBuildArgs: asset.dockerBuildArgs,
        dockerBuildTarget: asset.dockerBuildTarget,
        dockerFile: asset.dockerFile
      },
      destinations: {
        [this.manifestEnvName]: {
          repositoryName: this.repositoryName,
          imageTag,
          region: resolvedOr(this.stack.region, undefined),
          assumeRoleArn: this.assetPublishingRoleArn,
          assumeRoleExternalId: this.props.assetPublishingExternalId,
        }
      },
    };

    // Return CFN expression
    const repositoryName = this.cfnify(this.repositoryName);
    return {
      repositoryName,
      imageUri: `${this.stack.account}.dkr.ecr.${this.stack.region}.${this.stack.urlSuffix}/${repositoryName}:${imageTag}`,
    };
  }

  public writeStackArtifacts(session: ISynthesisSession): void {
    // Add the stack's template to the artifact manifest
    const stackTemplateAssetObjectUrl = this.addStackTemplateToAssetManifest(session);

    const artifactId = this.writeAssetManifest(session);

    writeStackToCloudAssembly(session, this.stack, {
      assumeRoleArn: this.deployActionRoleArn,
      cloudFormationExecutionRoleArn: this.cloudFormationExecutionRoleArn,
      stackTemplateAssetObjectUrl,
      requiresBootstrapStackVersion: 1,
    }, [artifactId]);
  }

  /**
   * Add the stack's template as one of the manifest assets
   *
   * This will make it get uploaded to S3 automatically by S3-assets. Return
   * the URL.
   */
  private addStackTemplateToAssetManifest(session: ISynthesisSession) {
    const templatePath = path.join(session.assembly.outdir, this.stack.templateFile);
    const template = fs.readFileSync(templatePath, { encoding: 'utf-8' });

    const assetLocation = this.addFileAsset({
      fileName: this.stack.templateFile,
      packaging: FileAssetPackaging.FILE,
      sourceHash: contentHash(template)
    });

    return assetLocation.s3Url;
  }

  /**
   * Write an asset manifest to the Cloud Assembly, return the artifact IDs written
   */
  private writeAssetManifest(session: ISynthesisSession): string {
    const artifactId = `${this.stack.artifactId}.assets`;
    const manifestFile = `${artifactId}.json`;
    const outPath = path.join(session.assembly.outdir, manifestFile);
    const text = JSON.stringify(this.assets, undefined, 2);
    fs.writeFileSync(outPath, text);

    session.assembly.addArtifact(artifactId, {
      type: cxschema.ArtifactType.ASSET_MANIFEST,
      properties: {
        file: manifestFile
      },
    });

    // FIXME: Add stack template as file asset
    return artifactId;
  }

  /**
   * If the string still contains placeholders, wrap it in a Fn::Sub so they will be substituted at CFN deploymen time
   */
  private cfnify(s: string): string {
    return s.indexOf('${') > -1 ? Fn.sub(s) : s;
  }

  private get manifestEnvName(): string {
    return [
      resolvedOr(this.stack.account, 'current_account'),
      resolvedOr(this.stack.region, 'current_region'),
    ].join('-');
  }
}

/**
 * Return the given value if resolved or fall back to a default
 */
function resolvedOr<A>(x: string, def: A): string | A {
  return Token.isUnresolved(x) ? def : x;
}

/**
 * Use the original deployment environment
 *
 * This deployment environment is restricted in cross-environment deployments,
 * CI/CD deployments, and will use up CloudFormation parameters in your template.
 *
 * This is the only DeploymentConfiguration that supports customizing asset behavior
 * by overriding `Stack.addFileAsset()` and `Stack.addDockerImageAsset()`.
 */
export class LegacyDeploymentConfiguration implements IDeploymentConfiguration {
  private stack!: Stack;
  private cycle = false;

  /**
   * Includes all parameters synthesized for assets (lazy).
   */
  private _assetParameters?: Construct;

  /**
   * The image ID of all the docker image assets that were already added to this
   * stack (to avoid duplication).
   */
  private readonly addedImageAssets = new Set<string>();

  public bind(stack: Stack): void {
    this.stack = stack;
  }

  public addFileAsset(asset: FileAssetSource): FileAssetLocation {
    // Backwards compatibility hack. We have a number of conflicting goals here:
    //
    // - We want put the actual logic in this class
    // - We ALSO want to keep supporting people overriding Stack.addFileAsset (for backwards compatibility,
    // because that mechanism is currently used to make CI/CD scenarios work)
    // - We ALSO want to allow both entry points from user code (our own framework
    // code will always call stack.deploymentMechanism.addFileAsset() but existing users
    // may still be calling `stack.addFileAsset()` directly.
    //
    // Solution: delegate call to the stack, but if the stack delegates back to us again
    // then do the actual logic.
    if (this.cycle) {
      return this.doAddFileAsset(asset);
    }
    this.cycle = true;
    try {
      return this.stack.addFileAsset(asset);
    } finally {
      this.cycle = false;
    }
  }

  public addDockerImageAsset(asset: DockerImageAssetSource): DockerImageAssetLocation {
    // See `addFileAsset` for explanation.
    if (this.cycle) {
      return this.doAddDockerImageAsset(asset);
    }
    this.cycle = true;
    try {
      return this.stack.addDockerImageAsset(asset);
    } finally {
      this.cycle = false;
    }
  }

  public writeStackArtifacts(session: ISynthesisSession): void {
    // Just do the default stuff, nothing special
    writeStackToCloudAssembly(session, this.stack, {}, []);
  }

  private doAddDockerImageAsset(asset: DockerImageAssetSource): DockerImageAssetLocation {
    // check if we have an override from context
    const repositoryNameOverride = this.stack.node.tryGetContext(ASSETS_ECR_REPOSITORY_NAME_OVERRIDE_CONTEXT_KEY);
    const repositoryName = asset.repositoryName ?? repositoryNameOverride ?? ASSETS_ECR_REPOSITORY_NAME;
    const imageTag = asset.sourceHash;
    const assetId = asset.sourceHash;

    // only add every image (identified by source hash) once for each stack that uses it.
    if (!this.addedImageAssets.has(assetId)) {
      const metadata: cxschema.ContainerImageAssetMetadataEntry = {
        repositoryName,
        imageTag,
        id: assetId,
        packaging: 'container-image',
        path: asset.directoryName,
        sourceHash: asset.sourceHash,
        buildArgs: asset.dockerBuildArgs,
        target: asset.dockerBuildTarget,
        file: asset.dockerFile,
      };

      this.stack.node.addMetadata(cxschema.ArtifactMetadataEntryType.ASSET, metadata);
      this.addedImageAssets.add(assetId);
    }

    return {
      imageUri: `${this.stack.account}.dkr.ecr.${this.stack.region}.${this.stack.urlSuffix}/${repositoryName}:${imageTag}`,
      repositoryName
    };
  }

  private doAddFileAsset(asset: FileAssetSource): FileAssetLocation {
    let params = this.assetParameters.node.tryFindChild(asset.sourceHash) as FileAssetParameters;
    if (!params) {
      params = new FileAssetParameters(this.assetParameters, asset.sourceHash);

      const metadata: cxschema.FileAssetMetadataEntry = {
        path: asset.fileName,
        id: asset.sourceHash,
        packaging: asset.packaging,
        sourceHash: asset.sourceHash,

        s3BucketParameter: params.bucketNameParameter.logicalId,
        s3KeyParameter: params.objectKeyParameter.logicalId,
        artifactHashParameter: params.artifactHashParameter.logicalId,
      };

      this.stack.node.addMetadata(cxschema.ArtifactMetadataEntryType.ASSET, metadata);
    }

    const bucketName = params.bucketNameParameter.valueAsString;

    // key is prefix|postfix
    const encodedKey = params.objectKeyParameter.valueAsString;

    const s3Prefix = Fn.select(0, Fn.split(cxapi.ASSET_PREFIX_SEPARATOR, encodedKey));
    const s3Filename = Fn.select(1, Fn.split(cxapi.ASSET_PREFIX_SEPARATOR, encodedKey));
    const objectKey = `${s3Prefix}${s3Filename}`;

    const s3Url = `https://s3.${this.stack.region}.${this.stack.urlSuffix}/${bucketName}/${objectKey}`;

    return { bucketName, objectKey, s3Url };
  }

  private get assetParameters() {
    if (!this._assetParameters) {
      this._assetParameters = new Construct(this.stack, 'AssetParameters');
    }
    return this._assetParameters;
  }
}

/**
 * Deployment environment for a nested stack
 *
 * Interoperates with the DeploymentConfiguration of the parent stack.
 */
export class NestedStackDeploymentConfiguration implements IDeploymentConfiguration {
  constructor(private readonly parentDeployment: IDeploymentConfiguration) {
  }

  public bind(_stack: Stack): void {
    // Nothing to do
  }

  public addFileAsset(asset: FileAssetSource): FileAssetLocation {
    // Forward to parent deployment. By the magic of cross-stack references any parameter
    // returned and used will magically be forwarded to the nested stack.
    return this.parentDeployment.addFileAsset(asset);
  }

  public addDockerImageAsset(asset: DockerImageAssetSource): DockerImageAssetLocation {
    // Forward to parent deployment. By the magic of cross-stack references any parameter
    // returned and used will magically be forwarded to the nested stack.
    return this.parentDeployment.addDockerImageAsset(asset);
  }

  public writeStackArtifacts(_session: ISynthesisSession): void {
    // Do not emit Nested Stack as a cloud assembly artifact.
    // It will be registered as an S3 asset of its parent instead.
  }
}

/**
 * Shared logic of writing stack artifact to the Cloud Assembly
 *
 * This logic is shared between DeploymentConfigurations.
 */
function writeStackToCloudAssembly(
  session: ISynthesisSession,
  stack: Stack,
  stackProps: Partial<cxapi.AwsCloudFormationStackProperties>,
  additionalStackDependencies: string[]) {

  const deps = [
    ...stack.dependencies.map(s => s.artifactId),
    ...additionalStackDependencies
  ];
  const meta = collectStackMetadata(stack);

  // backwards compatibility since originally artifact ID was always equal to
  // stack name the stackName attribute is optional and if it is not specified
  // the CLI will use the artifact ID as the stack name. we *could have*
  // always put the stack name here but wanted to minimize the risk around
  // changes to the assembly manifest. so this means that as long as stack
  // name and artifact ID are the same, the cloud assembly manifest will not
  // change.
  const stackNameProperty = stack.stackName === stack.artifactId
    ? { }
    : { stackName: stack.stackName };

  const properties: cxapi.AwsCloudFormationStackProperties = {
    templateFile: stack.templateFile,
    ...stackProps,
    ...stackNameProperty
  };

  // add an artifact that represents this stack
  session.assembly.addArtifact(stack.artifactId, {
    type: cxschema.ArtifactType.AWS_CLOUDFORMATION_STACK,
    environment: stack.environment,
    properties,
    dependencies: deps.length > 0 ? deps : undefined,
    metadata: Object.keys(meta).length > 0 ? meta : undefined,
  });
}

/**
 * Collect the metadata from a stack
 */
function collectStackMetadata(stack: Stack) {
  const output: { [id: string]: cxschema.MetadataEntry[] } = { };

  visit(stack);

  return output;

  function visit(node: IConstruct) {
    // break off if we reached a node that is not a child of this stack
    const parent = findParentStack(node);
    if (parent !== stack) {
      return;
    }

    if (node.node.metadata.length > 0) {
      // Make the path absolute
      output[ConstructNode.PATH_SEP + node.node.path] = node.node.metadata.map(md => stack.resolve(md) as cxschema.MetadataEntry);
    }

    for (const child of node.node.children) {
      visit(child);
    }
  }

  function findParentStack(node: IConstruct): Stack | undefined {
    if (node instanceof Stack && node.nestedStackParent === undefined) {
      return node;
    }

    if (!node.node.scope) {
      return undefined;
    }

    return findParentStack(node.node.scope);
  }
}

function contentHash(content: string) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * A "replace-all" function that doesn't require us escaping a literal string to a regex
 */
function replaceAll(s: string, search: string, replace: string) {
  return s.split(search).join(replace);
}