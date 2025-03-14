import { HttpStatusCode, IHttp, IModify, IPersistence, IRead, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiEndpoint, IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { AppSetting } from '../settings/Settings';
import * as crypto from 'crypto';

// 定义一个接口，包含我们需要的方法
interface IAsanaApp extends App {
    getLogger(): ILogger;
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
        this.app.getLogger().debug('Received Asana webhook:', request);

        // Verify webhook signature
        const isValid = await this.verifyWebhookSignature(request, read);
        if (!isValid) {
            return this.json({
                status: HttpStatusCode.UNAUTHORIZED,
                content: {
                    error: 'Invalid webhook signature',
                },
            });
        }

        // Handle Asana handshake challenge
        if (request.content && request.content.events && request.content.events.length === 0 && request.content.data && request.content.data.handshakeKey) {
            return this.json({
                status: HttpStatusCode.OK,
                content: {
                    handshakeKey: request.content.data.handshakeKey,
                },
            });
        }

        // Process webhook events
        if (request.content && request.content.events && request.content.events.length > 0) {
            await this.processEvents(request.content.events, read, modify, http, persis);
        }

        return this.json({
            status: HttpStatusCode.OK,
            content: {
                success: true,
            },
        });
    }

    private async verifyWebhookSignature(request: IApiRequest, read: IRead): Promise<boolean> {
        try {
            const webhookSecret = await read.getEnvironmentReader().getSettings().getValueById(AppSetting.AsanaWebhookSecret);
            if (!webhookSecret) {
                this.app.getLogger().error('Webhook secret not configured');
                return false;
            }

            const signature = request.headers['x-hook-signature'];
            if (!signature) {
                this.app.getLogger().error('No webhook signature provided');
                return false;
            }

            const hmac = crypto.createHmac('sha256', webhookSecret);
            hmac.update(JSON.stringify(request.content));
            const calculatedSignature = hmac.digest('hex');

            return signature === calculatedSignature;
        } catch (error) {
            this.app.getLogger().error('Error verifying webhook signature:', error);
            return false;
        }
    }

    private async processEvents(events: any[], read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        for (const event of events) {
            try {
                // Get the webhook configuration to find the associated room
                const webhookAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `webhook_${event.resource.gid}`);
                const [webhookConfig] = await read.getPersistenceReader().readByAssociation(webhookAssociation) as [{ roomId: string }];

                if (!webhookConfig || !webhookConfig.roomId) {
                    this.app.getLogger().warn(`No room configured for webhook ${event.resource.gid}`);
                    continue;
                }

                const room = await read.getRoomReader().getById(webhookConfig.roomId);
                if (!room) {
                    this.app.getLogger().warn(`Room ${webhookConfig.roomId} not found`);
                    continue;
                }

                // Process the event based on its type
                await this.processEvent(event, room, read, modify, http);
            } catch (error) {
                this.app.getLogger().error(`Error processing event ${event.gid}:`, error);
            }
        }
    }

    private async processEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        const resourceType = event.resource.resource_type;
        const action = event.action;

        if (resourceType === 'task') {
            await this.processTaskEvent(event, room, read, modify, http);
        } else if (resourceType === 'project') {
            await this.processProjectEvent(event, room, read, modify, http);
        } else {
            this.app.getLogger().debug(`Unhandled resource type: ${resourceType}`);
        }
    }

    private async processTaskEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        const taskId = event.resource.gid;
        const action = event.action;
        const user = event.user ? event.user.name : 'Someone';

        // Get task details
        const taskDetails = await this.getTaskDetails(taskId, read, http);
        if (!taskDetails) {
            this.app.getLogger().warn(`Could not get details for task ${taskId}`);
            return;
        }

        let message = '';
        const notificationColor = await read.getEnvironmentReader().getSettings().getValueById(AppSetting.NotificationColor) || '#FC636B';

        if (action === 'added') {
            message = `🆕 ${user} created a new task: *${taskDetails.name}*`;
        } else if (action === 'changed') {
            message = `🔄 ${user} updated task: *${taskDetails.name}*`;
        } else if (action === 'removed') {
            message = `🗑️ ${user} removed task: *${taskDetails.name}*`;
        } else if (action === 'completed') {
            message = `✅ ${user} completed task: *${taskDetails.name}*`;
        } else {
            message = `📝 Task *${taskDetails.name}* was ${action}`;
        }

        // Create and send the message
        const creator = modify.getCreator();
        const sender = await read.getUserReader().getAppUser();

        if (!sender) {
            this.app.getLogger().error('Could not get app user');
            return;
        }

        const messageBuilder = creator.startMessage()
            .setRoom(room)
            .setSender(sender);

        // Add attachment with task details
        const attachment = {
            color: notificationColor,
            title: taskDetails.name,
            titleLink: `https://app.asana.com/0/${taskDetails.projects[0]?.gid}/${taskId}`,
            text: taskDetails.notes || '',
            fields: [
                {
                    short: true,
                    title: 'Status',
                    value: taskDetails.completed ? 'Completed' : 'Incomplete',
                },
                {
                    short: true,
                    title: 'Due Date',
                    value: taskDetails.due_on ? new Date(taskDetails.due_on).toLocaleDateString() : 'No due date',
                },
                {
                    short: true,
                    title: 'Assignee',
                    value: taskDetails.assignee ? taskDetails.assignee.name : 'Unassigned',
                },
            ]
        };

        messageBuilder.setText(message);
        messageBuilder.addAttachment(attachment);

        await creator.finish(messageBuilder);
    }

    private async processProjectEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        // Similar to processTaskEvent but for projects
        // Implementation would be similar to task events
        this.app.getLogger().debug('Project event processing not implemented yet');
    }

    private async getTaskDetails(taskId: string, read: IRead, http: IHttp): Promise<any> {
        try {
            // Use a service account or admin token to get task details
            // This is a simplified example - in a real app, you'd need to handle authentication properly
            const adminAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, 'admin_token');
            const [adminToken] = await read.getPersistenceReader().readByAssociation(adminAssociation) as [{ access_token: string }];

            if (!adminToken || !adminToken.access_token) {
                this.app.getLogger().error('No admin token available for API calls');
                return null;
            }

            const response = await http.get(`https://app.asana.com/api/1.0/tasks/${taskId}?opt_fields=name,notes,completed,due_on,assignee,projects`, {
                headers: {
                    'Authorization': `Bearer ${adminToken.access_token}`,
                    'Accept': 'application/json',
                },
            });

            if (response.statusCode === 200) {
                return response.data.data;
            } else {
                this.app.getLogger().error(`Failed to get task details: ${response.content}`);
                return null;
            }
        } catch (error) {
            this.app.getLogger().error(`Error getting task details: ${error}`);
            return null;
        }
    }
} 