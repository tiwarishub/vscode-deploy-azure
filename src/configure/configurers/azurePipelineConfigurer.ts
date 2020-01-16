import { GenericResource } from 'azure-arm-resource/lib/resource/models';
import * as path from 'path';
import Q = require('q');
import * as utils from 'util';
import * as vscode from 'vscode';
import { UserCancelledError } from 'vscode-azureextensionui';
import { AppServiceClient, VSTSDeploymentMessage } from '../clients/azure/appServiceClient';
import { AzureDevOpsClient } from "../clients/devOps/azureDevOpsClient";
import { UniqueResourceNameSuffix } from '../configure';
import { generateDevOpsOrganizationName, generateDevOpsProjectName } from '../helper/commonHelper';
import { ControlProvider } from '../helper/controlProvider';
import { AzureDevOpsHelper } from "../helper/devOps/azureDevOpsHelper";
import { ServiceConnectionHelper } from '../helper/devOps/serviceConnectionHelper';
import { GraphHelper } from '../helper/graphHelper';
import { LocalGitRepoHelper } from '../helper/LocalGitRepoHelper';
import { telemetryHelper } from '../helper/telemetryHelper';
import { TemplateParameterHelper } from '../helper/templateParameterHelper';
import { Build } from '../model/azureDevOps';
import { AzureSession, RepositoryProvider, ServiceConnectionType, TargetResourceType, WizardInputs } from "../model/models";
import * as constants from '../resources/constants';
import { Messages } from '../resources/messages';
import { TelemetryKeys } from '../resources/telemetryKeys';
import { TracePoints } from '../resources/tracePoints';
import { Configurer } from "./configurerBase";


const Layer = 'AzurePipelineConfigurer';

export class AzurePipelineConfigurer implements Configurer {
    private azureDevOpsHelper: AzureDevOpsHelper;
    private azureDevOpsClient: AzureDevOpsClient;
    private queuedPipeline: Build;
    private controlProvider: ControlProvider;

    constructor(azureSession: AzureSession) {
        this.azureDevOpsClient = new AzureDevOpsClient(azureSession.credentials);
        this.azureDevOpsHelper = new AzureDevOpsHelper(this.azureDevOpsClient);
        this.controlProvider = new ControlProvider();
        this.azureDevOpsClient.listOrganizations(true);
    }

    public async getInputs(inputs: WizardInputs): Promise<void> {
        try {
            if(inputs.sourceRepository.repositoryProvider === RepositoryProvider.Github) {
                inputs.githubPATToken = await this.controlProvider.showInputBox(constants.GitHubPat, {
                    placeHolder: Messages.enterGitHubPat,
                    prompt: Messages.githubPatTokenHelpMessage,
                    validateInput: (inputValue) => {
                        return !inputValue ? Messages.githubPatTokenErrorMessage : null;
                    }
                });
            }

            inputs.isNewOrganization = false;

            if (!inputs.sourceRepository.remoteUrl || inputs.sourceRepository.repositoryProvider === RepositoryProvider.Github) {
                let devOpsOrganizations = await this.azureDevOpsClient.listOrganizations();

                if (devOpsOrganizations && devOpsOrganizations.length > 0) {
                    let selectedOrganization = await this.controlProvider.showQuickPick(
                        constants.SelectOrganization,
                        devOpsOrganizations.map(x => { return { label: x.accountName }; }),
                        { placeHolder: Messages.selectOrganization },
                        TelemetryKeys.OrganizationListCount);
                    inputs.organizationName = selectedOrganization.label;

                    let selectedProject = await this.controlProvider.showQuickPick(
                        constants.SelectProject,
                        this.azureDevOpsClient.listProjects(inputs.organizationName)
                            .then((projects) => projects.map(x => { return { label: x.name, data: x }; })),
                        { placeHolder: Messages.selectProject },
                        TelemetryKeys.ProjectListCount);
                    inputs.project = selectedProject.data;
                }
                else {
                    inputs.isNewOrganization = true;
                    let userName = inputs.azureSession.userId.substring(0, inputs.azureSession.userId.indexOf("@"));
                    let organizationName = generateDevOpsOrganizationName(userName, inputs.sourceRepository.repositoryName);

                    let validationErrorMessage = await this.azureDevOpsClient.validateOrganizationName(organizationName);
                    if (validationErrorMessage) {
                        inputs.organizationName = await this.controlProvider.showInputBox(
                            constants.EnterOrganizationName,
                            {
                                placeHolder: Messages.enterAzureDevOpsOrganizationName,
                                validateInput: (organizationName) => this.azureDevOpsClient.validateOrganizationName(organizationName)
                            });
                    }
                    else {
                        inputs.organizationName = organizationName;
                    }
                    inputs.project = {
                        id: "",
                        name: generateDevOpsProjectName(inputs.sourceRepository.repositoryName)
                    };
                }
            }
            else {
                let repoDetails = AzureDevOpsHelper.getRepositoryDetailsFromRemoteUrl(inputs.sourceRepository.remoteUrl);
                inputs.organizationName = repoDetails.organizationName;
                await this.azureDevOpsClient.getRepository(inputs.organizationName, repoDetails.projectName, inputs.sourceRepository.repositoryName)
                    .then((repository) => {
                        inputs.sourceRepository.repositoryId = repository.id;
                        inputs.project = {
                            id: repository.project.id,
                            name: repository.project.name
                        };
                    });
            }

            telemetryHelper.setTelemetry(TelemetryKeys.NewOrganization, inputs.isNewOrganization.toString());
        }
        catch (error) {
            telemetryHelper.logError(Layer, TracePoints.GetAzureDevOpsDetailsFailed, error);
            throw error;
        }
    }

    public async validatePermissions(): Promise<void> {
        return;
    }

    public async createPreRequisites(inputs: WizardInputs): Promise<void> {
        if (inputs.isNewOrganization) {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: Messages.creatingAzureDevOpsOrganization
                },
                async () => {
                    try {
                        // Create DevOps organization
                        await this.azureDevOpsClient.createOrganization(inputs.organizationName);
                        this.azureDevOpsClient.listOrganizations(true);

                        // Create DevOps project
                        await this.azureDevOpsClient.createProject(inputs.organizationName, inputs.project.name);
                        inputs.project.id = await this.azureDevOpsClient.getProjectIdFromName(inputs.organizationName, inputs.project.name);
                    }
                    catch (error) {
                        telemetryHelper.logError(Layer, TracePoints.CreateNewOrganizationAndProjectFailure, error);
                        throw error;
                    }
                });
        }

        let serviceConnectionHelper = new ServiceConnectionHelper(inputs.organizationName, inputs.project.name, this.azureDevOpsClient);

        if (inputs.sourceRepository.repositoryProvider === RepositoryProvider.Github) {
            // Create GitHub service connection in Azure DevOps
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: Messages.creatingGitHubServiceConnection
                },
                async () => {
                    try {
                        let serviceConnectionName = `${inputs.sourceRepository.repositoryName}-${UniqueResourceNameSuffix}`;
                        inputs.sourceRepository.serviceConnectionId = await serviceConnectionHelper.createGitHubServiceConnection(serviceConnectionName, inputs.githubPATToken);
                    }
                    catch (error) {
                        telemetryHelper.logError(Layer, TracePoints.GitHubServiceConnectionError, error);
                        throw error;
                    }
                });
        }

        if (!!inputs.targetResource.resource) {
            // TODO: show notification while setup is being done.
            // ?? should SPN created be scoped to resource group of target azure resource.
            inputs.targetResource.serviceConnectionId = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: utils.format(Messages.creatingAzureServiceConnection, inputs.targetResource.subscriptionId)
                },
                async () => {
                    try {
                        let scope = inputs.targetResource.resource.id;
                        let aadAppName = GraphHelper.generateAadApplicationName(inputs.organizationName, inputs.project.name);
                        let aadApp = await GraphHelper.createSpnAndAssignRole(inputs.azureSession, aadAppName, scope);
                        let serviceConnectionName = `${inputs.targetResource.resource.name}-${UniqueResourceNameSuffix}`;
                        return await serviceConnectionHelper.createARMServiceConnection(serviceConnectionName, inputs.azureSession.tenantId, inputs.targetResource.subscriptionId, scope, aadApp);
                    }
                    catch (error) {
                        telemetryHelper.logError(Layer, TracePoints.AzureServiceConnectionCreateFailure, error);
                        throw error;
                    }
                });
        }
    }

    public async createSecretOrServiceConnection(
        name: string,
        type: ServiceConnectionType,
        data: any,
        inputs: WizardInputs): Promise<string> {
        let serviceConnectionHelper = new ServiceConnectionHelper(inputs.organizationName, inputs.project.name, this.azureDevOpsClient);

        switch (type) {
            case ServiceConnectionType.AzureRM:
                return await serviceConnectionHelper.createARMServiceConnection(name, inputs.azureSession.tenantId, inputs.targetResource.subscriptionId, data.scope, data.aadApp);
            case ServiceConnectionType.ACR:
            case ServiceConnectionType.AKS:
            default:
                throw new Error(utils.format(Messages.assetOfTypeNotSupported, type));
        }
    }

    public async getPathToPipelineFile(inputs: WizardInputs, localGitRepoHelper: LocalGitRepoHelper): Promise<string> {
        return path.join(inputs.sourceRepository.localPath, await LocalGitRepoHelper.GetAvailableFileName('azure-pipelines.yml', inputs.sourceRepository.localPath));
    }

    public async checkInPipelineFileToRepository(inputs: WizardInputs, localGitRepoHelper: LocalGitRepoHelper): Promise<string> {

        let commitMessage: string;
        let initializeGitRepository = !inputs.sourceRepository.remoteUrl;

        if (!inputs.sourceRepository.remoteUrl) {
            commitMessage = Messages.modifyAndCommitFileWithGitInitialization;
            telemetryHelper.setTelemetry(TelemetryKeys.NewDevOpsRepository, 'true');
        }
        else {
            commitMessage = utils.format(Messages.modifyAndCommitFile, Messages.commitAndPush, inputs.sourceRepository.branch, inputs.sourceRepository.remoteName);
            telemetryHelper.setTelemetry(TelemetryKeys.NewDevOpsRepository, 'false');
        }

        while (!inputs.sourceRepository.commitId) {
            let commitOrDiscard = await vscode.window.showInformationMessage(
                commitMessage,
                Messages.commitAndPush,
                Messages.discardPipeline);

            if (!!commitOrDiscard && commitOrDiscard.toLowerCase() === Messages.commitAndPush.toLowerCase()) {
                inputs.sourceRepository.commitId = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: Messages.configuringPipelineAndDeployment }, async () => {
                    try {
                        if (!inputs.sourceRepository.remoteUrl) {
                            let repositoryName = path.basename(inputs.sourceRepository.localPath).trim().replace(/[^a-zA-Z0-9-]/g, '');
                            repositoryName = !!repositoryName ? repositoryName : "codetoazure";
                            let repository = await this.azureDevOpsClient.createRepository(inputs.organizationName, inputs.project.id, repositoryName);
                            inputs.sourceRepository.repositoryName = repository.name;
                            inputs.sourceRepository.repositoryId = repository.id;
                            inputs.sourceRepository.remoteUrl = repository.remoteUrl;
                        }

                        if (initializeGitRepository) {
                            await localGitRepoHelper.initializeGitRepository(inputs.sourceRepository.remoteName, inputs.sourceRepository.remoteUrl, inputs.pipelineConfiguration.filePath);

                            let branchDetails = await localGitRepoHelper.getGitBranchDetails();
                            inputs.sourceRepository.branch = branchDetails.branch;
                            initializeGitRepository = false;
                        }

                        // handle when the branch is not upto date with remote branch and push fails
                        return await localGitRepoHelper.commitAndPushPipelineFile(inputs.pipelineConfiguration.filePath, inputs.sourceRepository, Messages.addAzurePipelinesYmlFile);
                    }
                    catch (error) {
                        telemetryHelper.logError(Layer, TracePoints.CheckInPipelineFailure, error);
                        vscode.window.showErrorMessage(utils.format(Messages.commitFailedErrorMessage, error.message));
                        return null;
                    }
                });
            }
            else {
                telemetryHelper.setTelemetry(TelemetryKeys.PipelineDiscarded, 'true');
                throw new UserCancelledError(Messages.operationCancelled);
            }
        }

        return inputs.sourceRepository.commitId;
    }

    public async createAndQueuePipeline(inputs: WizardInputs): Promise<string> {
        this.queuedPipeline = await vscode.window.withProgress<Build>({ location: vscode.ProgressLocation.Notification, title: Messages.configuringPipelineAndDeployment }, async () => {
            try {
                let targetResource = AzurePipelineConfigurer.getTargetResource(inputs);

                let pipelineName = `${(targetResource ? targetResource.name : inputs.pipelineConfiguration.template.label)}-${UniqueResourceNameSuffix}`;
                return await this.azureDevOpsHelper.createAndRunPipeline(pipelineName, inputs);
            }
            catch (error) {
                telemetryHelper.logError(Layer, TracePoints.CreateAndQueuePipelineFailed, error);
                throw error;
            }
        });

        return this.queuedPipeline._links.web.href;
    }

    public async executePostPipelineCreationSteps(inputs: WizardInputs): Promise<void> {
        if (inputs.pipelineConfiguration.template.targetType === TargetResourceType.WebApp) {
            try {
                let appServiceClient = new AppServiceClient(inputs.azureSession.credentials, inputs.azureSession.environment, inputs.azureSession.tenantId, inputs.subscriptionId);
                // update SCM type
                let targetResource: GenericResource = AzurePipelineConfigurer.getTargetResource(inputs);

                let updateScmPromise = appServiceClient.updateScmType(targetResource.id);

                let buildDefinitionUrl = this.azureDevOpsClient.getOldFormatBuildDefinitionUrl(inputs.organizationName, inputs.project.id, this.queuedPipeline.definition.id);
                let buildUrl = this.azureDevOpsClient.getOldFormatBuildUrl(inputs.organizationName, inputs.project.id, this.queuedPipeline.id);

                // update metadata of app service to store information about the pipeline deploying to web app.
                let updateMetadataPromise = new Promise<void>(async (resolve) => {
                    let metadata = await appServiceClient.getAppServiceMetadata(targetResource.id);
                    metadata["properties"] = metadata["properties"] ? metadata["properties"] : {};
                    metadata["properties"]["VSTSRM_ProjectId"] = `${inputs.project.id}`;
                    metadata["properties"]["VSTSRM_AccountId"] = await this.azureDevOpsClient.getOrganizationIdFromName(inputs.organizationName);
                    metadata["properties"]["VSTSRM_BuildDefinitionId"] = `${this.queuedPipeline.definition.id}`;
                    metadata["properties"]["VSTSRM_BuildDefinitionWebAccessUrl"] = `${buildDefinitionUrl}`;
                    metadata["properties"]["VSTSRM_ConfiguredCDEndPoint"] = '';
                    metadata["properties"]["VSTSRM_ReleaseDefinitionId"] = '';

                    appServiceClient.updateAppServiceMetadata(targetResource.id, metadata);
                    resolve();
                });

                // send a deployment log with information about the setup pipeline and links.
                let deploymentMessage = JSON.stringify(<VSTSDeploymentMessage>{
                    type: constants.DeploymentMessageType,
                    message: Messages.deploymentLogMessage,
                    VSTSRM_BuildDefinitionWebAccessUrl: `${buildDefinitionUrl}`,
                    VSTSRM_ConfiguredCDEndPoint: '',
                    VSTSRM_BuildWebAccessUrl: `${buildUrl}`,
                });

                let updateDeploymentLogPromise = appServiceClient.publishDeploymentToAppService(
                    targetResource.id, deploymentMessage);

                Q.all([updateScmPromise, updateMetadataPromise, updateDeploymentLogPromise])
                    .then(() => {
                        telemetryHelper.setTelemetry(TelemetryKeys.UpdatedWebAppMetadata, 'true');
                    });
            }
            catch (error) {
                telemetryHelper.logError(Layer, TracePoints.PostDeploymentActionFailed, error);
            }
        }
    }

    public async browseQueuedPipeline(): Promise<void> {
        vscode.window.showInformationMessage(Messages.pipelineSetupSuccessfully, Messages.browsePipeline)
            .then((action: string) => {
                if (action && action.toLowerCase() === Messages.browsePipeline.toLowerCase()) {
                    telemetryHelper.setTelemetry(TelemetryKeys.BrowsePipelineClicked, 'true');
                    vscode.env.openExternal(vscode.Uri.parse(this.queuedPipeline._links.web.href));
                }
            });
    }

    private static getTargetResource(inputs: WizardInputs) : GenericResource {
        let targetResource = !!inputs.targetResource.resource ? inputs.targetResource.resource : null;
        if (!targetResource) {
            let targetParam = TemplateParameterHelper.getParameterForTargetResourceType(inputs.pipelineConfiguration.template.parameters, inputs.pipelineConfiguration.template.targetType);
            if (!!targetParam && !!inputs.pipelineConfiguration.params[targetParam.name]) {
                targetResource = inputs.pipelineConfiguration.params[targetParam.name];
            }
            else {
                throw new Error(utils.format(Messages.couldNotFindTargetResourceValueInParams, inputs.pipelineConfiguration.template.targetType));
            }
        }

        return targetResource;
    }
}
