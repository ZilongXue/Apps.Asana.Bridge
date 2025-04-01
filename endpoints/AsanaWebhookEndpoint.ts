import { HttpStatusCode, IHttp, IModify, IPersistence, IRead, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiEndpoint, IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { App } from '@rocket.chat/apps-engine/definition/App';
import * as crypto from 'crypto';

/**
 * Asana event payload interface definition
 */
export interface IAsanaEventPayload {
    // basic event information
    action: string;
    resource: {
        gid: string;
        resource_type: string;
        [key: string]: any;
    };
    
    // optional fields
    user?: {
        gid: string;
        name?: string;
        resource_type: string;
    };
    
    parent?: {
        gid: string;
        resource_type: string;
    };
    
    webhook?: {
        gid: string;
        resource_type: string;
    };
    
    // other arbitrary fields
    [key: string]: any;
}

/**
 * message attachment interface definition
 */
interface IAttachment {
    color?: string;
    title?: {
        value: string;
    };
    titleLink?: string;
    text?: string;
    fields?: Array<{
        short: boolean;
        title: string;
        value: any;
    }>;
    [key: string]: any;
}

/**
 * message attachment type alias, for function return type
 */
type IMessageAttachment = IAttachment;

/**
 * Webhook mapping relation data model
 */
interface WebhookMapping {
    // primary key: webhook ID
    webhookId: string;
    // associated resource ID (project ID or workspace ID)
    resourceId: string;
    // room ID to receive notifications
    roomId: string;
    // creator user ID
    createdBy?: string;
    // creation time
    createdAt: string;
    // whether the configuration is automatically created
    autoCreated?: boolean;
}

/**
    * Asana任务详情接口
 */
interface IAsanaTaskDetails {
    gid: string;
    name: string;
    notes?: string;
    due_on?: string;
    assignee?: {
        gid: string;
        name: string;
    };
    projects?: Array<{
        gid: string;
        name: string;
    }>;
    [key: string]: any;
}

/**
 * Asana project details interface
 */
interface IAsanaProjectDetails {
    gid: string;
    name: string;
    notes?: string;
    archived?: boolean;
    workspace?: {
        gid: string;
        name: string;
    };
    owner?: {
        gid: string;
        name: string;
    };
    [key: string]: any;
}

interface IAsanaApp extends App {
    getLogger(): ILogger;
    getOAuth2Service(): any; // Asana OAuth2 Service
    getApiService(): any; // Asana API Service
}

export class AsanaWebhookEndpoint extends ApiEndpoint {
    public path = 'webhook';

    constructor(public readonly app: IAsanaApp) {
        super(app);
    }

    public async post(
        request: IApiRequest,
        endpoint: IApiEndpointInfo,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persis: IPersistence,
    ): Promise<IApiResponse> {
        // process handshake request
        const handshakeResponse = await this.handleWebhookHandshake(request, persis);
        if (handshakeResponse) {
            return handshakeResponse;
        }

        // Verify webhook signature for event payloads
        const isValid = await this.verifyWebhookSignature(request, read, persis);
        if (!isValid) {
            return this.json({
                status: HttpStatusCode.UNAUTHORIZED,
                content: {
                    error: 'Invalid webhook signature',
                },
            });
        }

        // process event payload (when receiving real events)
        if (request.content && request.content.events && request.content.events.length > 0) {
            this.app.getLogger().debug('Processing webhook events:', request.content.events.length);
            await this.processEvents(request.content.events, read, modify, http, persis);
        }

        return this.json({
            status: HttpStatusCode.OK,
            content: {
                success: true,
            },
        });
    }

    /**
     * handle Asana webhook handshake request
     */
    private async handleWebhookHandshake(request: IApiRequest, persis: IPersistence): Promise<IApiResponse | null> {
        if (request.headers && request.headers['x-hook-secret']) {
            const hookSecret = request.headers['x-hook-secret'];
            this.app.getLogger().debug('received handshake request, secret:', hookSecret);
            
            // save secret
            try {
                // store the latest secret, for all webhook verification
                const latestSecretAssociation = new RocketChatAssociationRecord(
                        RocketChatAssociationModel.MISC, 
                    'asana_webhook_secret_latest'
                );
                
                await persis.updateByAssociation(latestSecretAssociation, { secret: hookSecret });
                this.app.getLogger().debug('successfully saved the latest webhook secret');
                
                // save secret for all webhooks for backward compatibility
                await persis.updateByAssociation(
                    new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, 'asana_webhook_secret'),
                    { secret: hookSecret }
                );
            } catch (error) {
                this.app.getLogger().error('failed to save webhook secret:', error);
            }
            
            // response handshake request, return the same secret in headers
            return {
                status: HttpStatusCode.OK,
                headers: {
                    'X-Hook-Secret': hookSecret
                },
                content: ''
            };
        }
        
        return null;
    }

    private async verifyWebhookSignature(request: IApiRequest, read: IRead, persis: IPersistence): Promise<boolean> {
        try {
            // for handshake request, return true
            if (request.headers && request.headers['x-hook-secret']) {
                return true;
            }

            // fetch signature from headers
            const signature = request.headers['x-hook-signature'] || request.headers['x-asana-request-signature'];
            if (!signature) {
                this.app.getLogger().error('no webhook signature provided in headers:', request.headers);
                return false;
            }
            
            // fetch all possible secrets
            const secrets = await this.getAllStoredSecrets(read, null);
            if (secrets.length === 0) {
                this.app.getLogger().error('no webhook secret found in persistence');
                return false;
            }
            
            // calculate the JSON string of request content
            let requestContent = JSON.stringify(request.content);
            
            // try all secrets for verification
            for (const [index, secret] of secrets.entries()) {
                try {
                    // create HMAC
                    const hmac = crypto.createHmac('sha256', secret);
                    hmac.update(requestContent);
                    const calculatedSignature = hmac.digest('hex');
                    
                    this.app.getLogger().debug(`Secret #${index+1} calculated signature:`, calculatedSignature);
                    
                    if (signature === calculatedSignature) {
                        this.app.getLogger().debug(`successfully verified webhook signature using secret #${index+1}`);
                        return true;
                    }
                
                } catch (signatureError) {
                    this.app.getLogger().debug(`error calculating signature using secret #${index+1}:`, signatureError);
                }
            }

            this.app.getLogger().error('webhook signature verification failed, no matching secret') 
            // signature verification failed, return false
            return false;
        } catch (error) {
            this.app.getLogger().error('error verifying webhook signature:', error);
            return false;
        }
    }
    
    /**
     * get all possible webhook secrets
     */
    private async getAllStoredSecrets(read: IRead, webhookId: string | null): Promise<string[]> {
        const secrets: string[] = [];
        
        try {
            // simplify secret fetching logic, prioritize the latest secret
            // try to get the latest secret
            try {
                const latestSecretAssociation = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    'asana_webhook_secret_latest'
                );
                
                const [latestSecret] = await read.getPersistenceReader().readByAssociation(
                    latestSecretAssociation
                ) as [{ secret: string } | undefined];
                
                if (latestSecret && latestSecret.secret) {
                    secrets.push(latestSecret.secret);
                }
            } catch (latestSecretError) {
                this.app.getLogger().debug('error getting the latest secret:', latestSecretError);
            }
            
            return secrets;
        } catch (error) {
            this.app.getLogger().error('error getting stored webhook secrets:', error);
            return [];
        }
    }

    private async processEvents(events: any[], read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        this.app.getLogger().debug(`Received ${events.length} events...`);

        // Log resource IDs and types in events
        const resourceIds = events.map((e) => e.resource?.gid).filter(Boolean);
        const resourceTypes = events
            .map((e) => e.resource?.resource_type)
            .filter(Boolean);
        this.app
            .getLogger()
            .debug(`Event resource IDs: ${resourceIds.join(", ")}`);
        this.app
            .getLogger()
            .debug(`Event resource types: ${resourceTypes.join(", ")}`);

        // Log parent resources, usually project IDs
        const parentIds = events
            .filter((e) => e.parent && e.parent.gid)
            .map((e) => e.parent.gid)
            .filter(Boolean);

        if (parentIds.length > 0) {
            this.app
                .getLogger()
                .debug(`Parent resource IDs: ${parentIds.join(", ")}`);
        }

        // Deduplicate events
        const uniqueEvents = this.deduplicateEvents(events);
        if (uniqueEvents.length !== events.length) {
            this.app
                .getLogger()
                .debug(
                    `Events deduplicated: original count ${events.length}, unique count ${uniqueEvents.length}`
                );
        }

        // Get all task events to fetch their project IDs
        const taskEvents = uniqueEvents.filter(
            (event) =>
                event.resource &&
                event.resource.resource_type === "task" &&
                event.resource.gid
        );

        // Get all project events and parent IDs
        const projectEvents = uniqueEvents.filter(
            (event) =>
                event.resource &&
                event.resource.resource_type === "project" &&
                event.resource.gid
        );

        // Collect all project IDs from parent fields
        const projectIds = new Set<string>();
        uniqueEvents.forEach((event) => {
            if (
                event.parent &&
                event.parent.gid &&
                event.parent.resource_type === "project"
            ) {
                projectIds.add(event.parent.gid);
            }
        });

        // use getAccessTokenForUser to get access token
        let accessToken = "";
        // get access token for the user, use app user instead of null
        try {
            const appUser = await read.getUserReader().getAppUser();
            if (appUser) {
                const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(appUser, read);
                if (tokenInfo && tokenInfo.access_token) {
                    accessToken = tokenInfo.access_token;
                } else {
                    this.app.getLogger().error('error getting access token for the user:', tokenInfo);
                }
            } else {
                this.app.getLogger().error('error getting app user');
            }
        } catch (error) {
            this.app.getLogger().error('error getting access token for the user:', error);
        }
        
        // For task events, retrieve project IDs using API
        if (taskEvents.length > 0) {
            // process task events to get project IDs
            if (accessToken) {
                for (const taskEvent of taskEvents) {
                    try {
                        const taskId = taskEvent.resource.gid;
                        const taskDetails = (await this.app
                            .getApiService()
                            .getTaskById(
                                accessToken,
                                taskId,
                                http
                            )) as IAsanaTaskDetails;

                        if (
                            taskDetails &&
                            taskDetails.projects &&
                            taskDetails.projects.length > 0
                        ) {
                            taskDetails.projects.forEach((project: any) => {
                                if (project.gid) {
                                    projectIds.add(project.gid);
                                    this.app
                                        .getLogger()
                                        .debug(
                                            `added project ID ${project.gid} from task ${taskId}`
                                        );
                                }
                            });
                        } else {
                            this.app
                                .getLogger()
                                .debug(`no project found for task ${taskId}`);
                        }
                    } catch (error) {
                        this.app
                            .getLogger()
                            .error(`error getting task details: ${error}`);
                    }
                }
            } else {
                this.app.getLogger().warn(`error getting access token, cannot get task details`);
            }
        }

        // For project events, add their resource IDs to the projectIds set
        projectEvents.forEach((event) => {
            if (event.resource && event.resource.gid) {
                projectIds.add(event.resource.gid);
                this.app
                    .getLogger()
                    .debug(
                        `Added project ID ${event.resource.gid} from project event`
                    );
            }
        });

        if (projectIds.size > 0) {
            this.app
                .getLogger()
                .debug(
                    `Found project IDs: ${Array.from(projectIds).join(", ")}`
                );

            // Track processed rooms to avoid duplicate messages
            const processedRooms = new Set<string>();

            // Process each project ID to find configurations and handle events
            for (const projectId of projectIds) {
                try {
                    // Find configuration by project ID
                    const mapping = await this.getWebhookMappingByResourceId(
                        projectId,
                        read
                    );

                    if (mapping && mapping.roomId) {
                        this.app
                            .getLogger()
                            .debug(
                                `Found mapping for project ${projectId}: roomId=${mapping.roomId}, webhookId=${mapping.webhookId}`
                            );

                        if (processedRooms.has(mapping.roomId)) {
                            continue;
                        }

                        const room = await read
                            .getRoomReader()
                            .getById(mapping.roomId);
                        if (room) {
                            // Process events for this room
                            for (const event of uniqueEvents) {
                                await this.processEvent(
                                    event,
                                    room,
                                    read,
                                    modify,
                                    http,
                                    accessToken || ""
                                );
                            }

                            processedRooms.add(mapping.roomId);
                            this.app
                                .getLogger()
                                .debug(
                                    `Messages sent to room ${mapping.roomId}`
                                );
                        } else {
                            this.app
                                .getLogger()
                                .warn(`Room not found: ${mapping.roomId}`);
                        }
                    } else {
                        this.app
                            .getLogger()
                            .debug(`No mapping found for project ${projectId}`);
                    }
                } catch (error) {
                    this.app
                        .getLogger()
                        .error(
                            `Error processing mapping for project ${projectId}: ${error}`
                        );
                }
            }

            // If at least one room was processed, return
            if (processedRooms.size > 0) {
                this.app
                    .getLogger()
                    .debug(
                        `Successfully processed events for ${processedRooms.size} rooms`
                    );
                return;
            }
        }

        // If no configuration found, log error
        this.app
            .getLogger()
            .warn(`No suitable webhook configuration found for these events`);
    }
    
    /**
     * deduplicate events
     * deduplicate events based on user.gid, action and resource.gid
     */
    private deduplicateEvents(events: any[]): any[] {
        if (!events || events.length <= 1) {
            return events;
        }
        
        const uniqueEvents: any[] = [];
        const uniqueEventKeys = new Set<string>();
        
        for (const event of events) {
            // generate unique key for the event
            const userId = event.user?.gid || 'unknown';
            const action = event.action || 'unknown';
            const resourceId = event.resource?.gid || 'unknown';
            
            // for changed events, also consider the specific change field
            let changeField = '';
            if (action === 'changed' && event.change && event.change.field) {
                // If event.change.field is 'due_on' or 'due_at', we consider as the same event
                if (event.change.field === 'due_on' || event.change.field === 'due_at') {
                    changeField = 'due_on';
                } else {
                    changeField = event.change.field;
                }
            }
            
            // create unique key
            const eventKey = `${userId}:${action}:${resourceId}${changeField ? ':' + changeField : ''}`;
            
            // check if the event key already exists
            if (!uniqueEventKeys.has(eventKey)) {
                uniqueEventKeys.add(eventKey);
                uniqueEvents.push(event);
            } else {
                this.app.getLogger().debug(`skipping duplicate event: ${eventKey}`);
            }
        }
        
        return uniqueEvents;
    }

    private async processEvent(
        event: IAsanaEventPayload,
        room: IRoom,
        read: IRead,
        modify: IModify,
        http: IHttp,
        accessToken: string | ""
    ): Promise<void> {
        try {
            this.app.getLogger().debug(`处理事件: ${event.action} ${event.resource.resource_type} ${event.resource.gid}`);
            
            // get sender info
            const appUser = await read.getUserReader().getAppUser();
            if (!appUser) {
                this.app.getLogger().error('error getting app user, cannot send message');
                return;
            }
        
            // process different types of events
            const attachments = await this.formatEventMessage(event, read, http, accessToken || '');
            if (attachments && attachments.length > 0) {

                const messageBuilder = modify.getCreator().startMessage()
                    .setRoom(room)
                    .setSender(appUser);
                
                let title = '';
                const resourceType = event.resource.resource_type;
                const action = event.action;
                
                switch (resourceType) {
                    case 'task':
                        title = `📋 Asana Task ${this.getActionText(action)}`;
                        break;
                    case 'project':
                        title = `📊 Asana Project ${this.getActionText(action)}`;
                        break;
                    case 'story':
                        title = `💬 Asana Comment Added`;
                        break;
                    case 'section':
                        title = `📑 Asana Section ${this.getActionText(action)}`;
                        break;
                    default:
                        title = `🔔 Asana Notification: ${resourceType} ${action}`;
                }
                
                messageBuilder.setText(title);
                
                // add attachments
                attachments.forEach(attachment => {
                    messageBuilder.addAttachment(attachment);
                });
                
                await modify.getCreator().finish(messageBuilder);
                this.app.getLogger().debug(`message sent to room ${room.id}`);
            } else {
                this.app.getLogger().warn(`no attachments created for the event, skip sending message`);
            }
        } catch (error) {
            this.app.getLogger().error(`error processing event: ${error}`);
        }
    }
    
    private getActionText(action: string): string {
        switch (action) {
            case 'added':
                return 'created';
            case 'changed':
                return 'updated';
            case 'removed':
                return 'deleted';
            case 'completed':
                return 'completed';
            case 'uncompleted':
                return 'uncompleted';
            case 'assigned':
                return 'assigned';
            case 'due':
                return 'due';
            default:
                return action;
        }
    }
   
    /**
     * get webhook mapping by resource ID
     */
    private async getWebhookMappingByResourceId(resourceId: string, read: IRead): Promise<WebhookMapping | null> {
        try {
            // get full mapping by resource_[resourceId]
            const resourceAssociation = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC, 
                `resource_${resourceId}`
            );
            
            const mappingResults = await read.getPersistenceReader().readByAssociation(resourceAssociation);
            const [mappingResult] = mappingResults as [WebhookMapping | undefined];

            if (mappingResult) {
                this.app.getLogger().debug(`found mapping by resource_${resourceId}: ${JSON.stringify(mappingResult)}`);
                return mappingResult;
            }
            
            this.app.getLogger().debug(`no mapping found for resource ID ${resourceId}`);
            return null;
        } catch (error) {
            this.app.getLogger().error(`error getting mapping by resource ID:`, error);
            return null;
        }
    }

    /**
     * get event details and format as message
     */
    private async formatEventMessage(event: IAsanaEventPayload, read: IRead, http: IHttp, accessToken: string | "" = ""): Promise<IMessageAttachment[]> {
        const attachments: IAttachment[] = [];
        const type = event.resource.resource_type;

        let userName = "unknown user";
        
        // fetch user name from asana api
        if (event.user && event.user.gid && accessToken) {
            try {
                const userData = await this.app.getApiService().getUserById(accessToken, event.user.gid, http);
                
                if (userData && userData.name) {
                    userName = userData.name;
                } else {
                    userName = `user ${event.user.gid}`;
                }
            } catch (error) {
                this.app.getLogger().error(`error getting user info: ${error}`);
                userName = `user ${event.user.gid}`;
            }
        } else {
            this.app.getLogger().debug('no user info in event, using default name');
        }

  
        try {
            // format different types of events
            switch (type) {
                case 'task':
                    attachments.push(await this.formatTaskEvent(event, accessToken, http, userName));
                    break;
                case 'project':
                    attachments.push(await this.formatProjectEvent(event, accessToken, http, userName));
                    break;
                case 'story':
                    attachments.push(await this.formatStoryEvent(event, accessToken, http, userName));
                    break;
                case 'section':
                    attachments.push(await this.formatSectionEvent(event, accessToken, http, userName));
                    break;
                default:
                    this.app.getLogger().debug(`unsupported resource type: ${type}`);
                    attachments.push({
                        color: '#FF0000',
                        text: `received an event of type ${type}, but currently not supported`,
                    });
            }
        } catch (error) {
            this.app.getLogger().error(`error formatting event message: ${error}`);
            attachments.push({
                color: '#FF0000',
                text: `error formatting event message: ${error}`,
            });
        }

        return attachments;
    }

    /**
     * format task related events
     */
    private async formatTaskEvent(
        event: IAsanaEventPayload,
        accessToken: string | "",
        http: IHttp,
        userName: string
    ): Promise<IAttachment> {
        const taskId = event.resource.gid;
        const action = event.action;

        // get task details
        let taskDetails: IAsanaTaskDetails | null = null;
        let projectDetails: IAsanaProjectDetails | null = null;

        try {
            // try to get task details
            if (accessToken) {
                taskDetails = (await this.app
                    .getApiService()
                    .getTaskById(
                        accessToken,
                        taskId,
                        http
                    )) as IAsanaTaskDetails;

                // if the task has projects, get the first project details
                if (
                    taskDetails &&
                    taskDetails.projects &&
                    taskDetails.projects.length > 0
                ) {
                    const projectId = taskDetails.projects[0].gid;
                    projectDetails = (await this.app
                        .getApiService()
                        .getProjectById(
                            accessToken,
                            projectId,
                            http
                        )) as IAsanaProjectDetails;
                }
            }
        } catch (error) {
            this.app.getLogger().error("error getting task or project details:", error);
        }

        // select appropriate color
        let notificationColor = "#FC636B"; // default red
        if (action === "completed") {
            notificationColor = "#36a64f"; // completed as green
        } else if (action === "changed") {
            notificationColor = "#2196F3"; // changed as blue
        }

        // build message text
        let messageText = "";
        switch (action) {
            case "added":
                messageText = `🆕 ${userName} created a new task`;
                break;
            case "changed":
                messageText = `🔄 ${userName} updated the task`;
                break;
            case "removed":
                messageText = `🗑️ ${userName} deleted the task`;
                break;
            case "completed":
                messageText = `✅ ${userName} completed the task`;
                break;
            case "uncompleted":
                messageText = `🔄 ${userName} marked the task as uncompleted`;
                break;
            case "assigned":
                const assignee = taskDetails?.assignee
                    ? taskDetails.assignee.name
                    : "someone";
                messageText = `👤 ${userName} assigned the task to ${assignee}`;
                break;
            case "due":
                messageText = `📅 ${userName} set the task due date`;
                break;
            default:
                messageText = `📋 task was ${action}`;
        }

        // prepare attachment message
        const attachment: IAttachment = {
            color: notificationColor,
            title: taskDetails
                ? { value: taskDetails.name }
                : { value: `task ${taskId}` },
            titleLink:
                taskDetails &&
                taskDetails.projects &&
                taskDetails.projects.length > 0
                    ? `https://app.asana.com/0/${taskDetails.projects[0].gid}/${taskId}`
                    : `https://app.asana.com/0/0/${taskId}`,
            text: messageText,
            fields: [],
        };

        // add task details fields
        if (taskDetails) {
            // add status field
            attachment.fields?.push({
                short: true,
                title: "status",
                value: taskDetails.completed ? "completed" : "in progress",
            });

            // add due date field
            if (taskDetails.due_on) {
                try {
                    const dueDate = new Date(taskDetails.due_on);
                    const formattedDate = `${dueDate.getFullYear()}-${String(
                        dueDate.getMonth() + 1
                    ).padStart(2, "0")}-${String(dueDate.getDate()).padStart(
                        2,
                        "0"
                    )}`;
                    attachment.fields?.push({
                        short: true,
                        title: "due date",
                        value: formattedDate,
                    });
                } catch (e) {
                    attachment.fields?.push({
                        short: true,
                        title: "due date",
                        value: taskDetails.due_on,
                    });
                }
            } else {
                attachment.fields?.push({
                    short: true,
                    title: "due date",
                    value: "no due date",
                });
            }

            // add assignee field
            attachment.fields?.push({
                short: true,
                title: "assignee",
                value: taskDetails.assignee
                    ? taskDetails.assignee.name
                    : "no assignee",
            });

            // add project field
            if (projectDetails) {
                attachment.fields?.push({
                    short: true,
                    title: "project",
                    value: projectDetails.name,
                });

                // add workspace field
                if (projectDetails.workspace) {
                    attachment.fields?.push({
                        short: true,
                        title: "workspace",
                        value: projectDetails.workspace.gid,
                    });
                }
            } else if (
                taskDetails.projects &&
                taskDetails.projects.length > 0
            ) {
                // if no project details, but has project basic info
                attachment.fields?.push({
                    short: true,
                    title: "project",
                    value: taskDetails.projects.map((p) => p.name).join(", "),
                });
            }

            // add task description
            if (taskDetails.notes && taskDetails.notes.trim() !== "") {
                const truncatedNotes =
                    taskDetails.notes.length > 300
                        ? taskDetails.notes.substring(0, 297) + "..."
                        : taskDetails.notes;

                attachment.fields?.push({
                    short: false,
                    title: "description",
                    value: truncatedNotes,
                });
            }
        }

        return attachment;
    }

    /**
     * format project related events
     */
    private async formatProjectEvent(
        event: IAsanaEventPayload,
        accessToken: string | "",
        http: IHttp,
        userName: string
    ): Promise<IAttachment> {
        const projectId = event.resource.gid;
        const action = event.action;
        
        // get project details
        let projectDetails: IAsanaProjectDetails | null = null;
        
        try {
            // try to get project details
            if (accessToken) {
                projectDetails = await this.app.getApiService().getProjectById(accessToken, projectId, http) as IAsanaProjectDetails;
            }
        } catch (error) {
            this.app.getLogger().error('error getting project details:', error);
        }
        
        // select appropriate color
        let notificationColor = '#36a64f';  // default green
        if (action === 'removed' || action === 'deleted') {
            notificationColor = '#FC636B';  // delete as red
        } else if (action === 'changed') {
            notificationColor = '#2196F3';  // update as blue
        }
        
        // build message text
        let messageText = '';
        
        switch (action) {
            case 'added':
                messageText = `🆕 ${userName} created a new project`;
                break;
            case 'changed':
                messageText = `🔄 ${userName} updated the project`;
                break;
            case 'removed':
                messageText = `🗑️ ${userName} deleted the project`;
                break;
            default:
                messageText = `📊 the project was ${action}`;
        }
        
        // prepare attachment message
        const attachment: IAttachment = {
            color: notificationColor,
            title: projectDetails ? { value: projectDetails.name } : { value: `project ${projectId}` },
            titleLink: `https://app.asana.com/0/${projectId}`,
            text: messageText,
            fields: []
        };
        
        // add project details fields
        if (projectDetails) {
            // add status field
            attachment.fields?.push({
                short: true,
                title: 'status',
                value: projectDetails.archived ? 'archived' : 'active',
            });
            
            // add workspace field
            if (projectDetails.workspace) {
                attachment.fields?.push({
                    short: true,
                    title: 'workspace',
                    value: projectDetails.workspace.name,
                });
            }
            
            // add owner field
            if (projectDetails.owner) {
                attachment.fields?.push({
                    short: true,
                    title: 'owner',
                    value: projectDetails.owner.name,
                });
            }
            
            // add project description
            if (projectDetails.notes && projectDetails.notes.trim() !== '') {
                const truncatedNotes = projectDetails.notes.length > 300 
                    ? projectDetails.notes.substring(0, 297) + '...' 
                    : projectDetails.notes;
                    
                attachment.fields?.push({
                    short: false,
                    title: 'description',
                    value: truncatedNotes,
                });
            }
        }
        
        return attachment;
    }

    /**
     * format section related events
     */
    private async formatSectionEvent(
        event: IAsanaEventPayload,
        accessToken: string | "",
        http: IHttp,
        userName: string
    ): Promise<IAttachment> {
        const sectionId = event.resource.gid;
        const action = event.action;
        
        // section details and associated project
        let sectionName = event.resource.name || `section ${sectionId}`;
        let projectDetails: IAsanaProjectDetails | null = null;
        
        try {
            // try to get associated project
            if (accessToken && event.parent && event.parent.gid && event.parent.resource_type === 'project') {
                const projectId = event.parent.gid;
                projectDetails = await this.app.getApiService().getProjectById(accessToken, projectId, http) as IAsanaProjectDetails;
            }
        } catch (error) {
            this.app.getLogger().error('error getting section details:', error);
        }
        
        // select appropriate color
        let notificationColor = '#9966CC';  // default purple
        if (action === 'removed' || action === 'deleted') {
            notificationColor = '#FC636B';  // delete as red
        } else if (action === 'changed') {
            notificationColor = '#2196F3';  // update as blue
        }
        
        // build message text
        let messageText = '';
        
        switch (action) {
            case 'added':
                messageText = `📋 ${userName} created a new section in the project`;
                break;
            case 'changed':
                messageText = `📋 ${userName} updated the section in the project`;
                break;
            case 'removed':
                messageText = `🗑️ ${userName} deleted the section from the project`;
                break;
            default:
                messageText = `📋 the section was ${action}`;
        }
        
        // prepare attachment message
        const attachment: IAttachment = {
            color: notificationColor,
            title: { value: sectionName },
            text: messageText,
            fields: []
        };
        
        // if there is project details, add to attachment
        if (projectDetails) {
            // create project link
            attachment.titleLink = `https://app.asana.com/0/${projectDetails.gid}`;
            
            // add project field
            attachment.fields?.push({
                short: true,
                title: 'project',
                value: projectDetails.name,
            });
            
            // add workspace information
            if (projectDetails.workspace) {
                attachment.fields?.push({
                    short: true,
                    title: 'workspace',
                    value: projectDetails.workspace.name,
                });
            }
            
            // add project owner
            if (projectDetails.owner) {
                attachment.fields?.push({
                    short: true,
                    title: 'project owner',
                    value: projectDetails.owner.name,
                });
            }
        }
        
        // add section name and details
        attachment.fields?.push({
            short: true,
            title: 'section name',
            value: sectionName,
        });
        
        // add event type
        attachment.fields?.push({
            short: true,
            title: 'event type',
            value: this.getActionText(action),
        });
        
        return attachment;
    }
    
    /**
     * format comment/story related events
     */
    private async formatStoryEvent(
        event: IAsanaEventPayload,
        accessToken: string | "",
        http: IHttp,
        userName: string
    ): Promise<IAttachment> {
        const storyId = event.resource.gid;
        
        // comment (story) is usually associated with a task
        let taskDetails: IAsanaTaskDetails | null = null;
        let projectDetails: IAsanaProjectDetails | null = null;
        
        try {
            // try to get task details
            if (accessToken && event.parent && event.parent.gid && event.parent.resource_type === 'task') {
                const taskId = event.parent.gid;
                taskDetails = await this.app.getApiService().getTaskById(accessToken, taskId, http) as IAsanaTaskDetails;
                
                // if the task has a project, get the first project details
                if (taskDetails && taskDetails.projects && taskDetails.projects.length > 0) {
                    const projectId = taskDetails.projects[0].gid;
                    projectDetails = await this.app.getApiService().getProjectById(accessToken, projectId, http) as IAsanaProjectDetails;
                }
            }
        } catch (error) {
            this.app.getLogger().error('error getting comment/story details:', error);
        }
        
        // prepare comment text
        let commentText = event.text || '';
        if (commentText.length > 500) {
            commentText = commentText.substring(0, 497) + '...';
        }
        
        // build message text
        const messageText = `💬 ${userName} added a comment` + 
            (taskDetails ? ` on task: ${taskDetails.name}` : '');
        
        // prepare attachment message
        const attachment: IAttachment = {
            color: '#36C5F0',  // comment as blue
            title: taskDetails ? { value: taskDetails.name } : { value: 'comment' },
            text: messageText,
            fields: []
        };
        
        // if there is task details, add task link
        if (taskDetails) {
            // create task link
            const projectId = taskDetails.projects && taskDetails.projects.length > 0 
                ? taskDetails.projects[0].gid 
                : '0';
                
            attachment.titleLink = `https://app.asana.com/0/${projectId}/${taskDetails.gid}`;
            
            // add task status
            attachment.fields?.push({
                short: true,
                title: 'task status',
                value: taskDetails.completed ? 'completed' : 'in progress',
            });
            
            // add due date
            if (taskDetails.due_on) {
                try {
                    const dueDate = new Date(taskDetails.due_on);
                    const formattedDate = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}-${String(dueDate.getDate()).padStart(2, '0')}`;
                    attachment.fields?.push({
                        short: true,
                        title: 'due date',
                        value: formattedDate,
                    });
                } catch (e) {
                    attachment.fields?.push({
                        short: true,
                        title: 'due date',
                        value: taskDetails.due_on,
                    });
                }
            }
            
            // add assignee
            if (taskDetails.assignee) {
                attachment.fields?.push({
                    short: true,
                    title: 'assignee',
                    value: taskDetails.assignee.name,
                });
            }
        }
        
        // add project information
        if (projectDetails) {
            attachment.fields?.push({
                short: true,
                title: 'project',
                value: projectDetails.name,
            });
        }
        
        // add comment content
        if (commentText) {
            attachment.fields?.push({
                short: false,
                title: 'comment content',
                value: commentText,
            });
        }
        
        return attachment;
    }
}