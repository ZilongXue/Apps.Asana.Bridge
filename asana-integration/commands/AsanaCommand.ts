import { IHttp, IModify, IPersistence, IRead, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ISlashCommand, SlashCommandContext } from '@rocket.chat/apps-engine/definition/slashcommands';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { AsanaApiService } from '../lib/AsanaApiService';
import { AsanaOAuth2Service } from '../lib/AsanaOAuth2Service';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';

// Define an interface with the methods we need
interface IAsanaApp extends App {
    getLogger(): ILogger;
    getOAuth2Service(): AsanaOAuth2Service;
    getApiService(): AsanaApiService;
}

// Task type definition
interface AsanaTask {
    gid: string;
    name: string;
    completed: boolean;
    due_on?: string;
    notes?: string;
    projects?: Array<{
        gid: string;
        name: string;
    }>;
    assignee?: {
        gid: string;
        name: string;
    };
    created_at?: string;
    modified_at?: string;
    html_notes?: string;
    custom_fields?: any[];
}

interface AsanaProject {
    gid: string;
    name: string;
    public?: boolean;
}

export class AsanaCommand implements ISlashCommand {
    public command = 'asana';
    public i18nDescription = 'Interact with Asana';
    public i18nParamsExample = 'auth | tasks | projects | task <task_id> | summary | webhook | logout | help';
    public providesPreview = false;

    constructor(private readonly app: IAsanaApp) {}

    public async executor(context: SlashCommandContext, read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        const [command, ...params] = context.getArguments();
        const sender = context.getSender();
        const room = context.getRoom();

        try {
            switch (command?.toLowerCase()) {
                case 'auth':
                    await this.authCommand(sender, room, read, modify);
                    break;
                case 'tasks':
                    await this.tasksCommand(sender, room, read, modify, http);
                    break;
                case 'projects':
                    await this.projectsCommand(sender, room, read, modify, http);
                    break;
                case 'task':
                    if (params.length > 0) {
                        await this.taskCommand(sender, room, params[0], read, modify, http);
                    } else {
                        await this.sendNotification(modify, room, sender, 'Please provide a task ID: `/asana task <task_id>`');
                    }
                    break;
                case 'webhook':
                    await this.webhookCommand(sender, room, params, read, modify, http, persis);
                    break;
                case 'summary':
                    await this.summaryCommand(sender, room, read, modify, http);
                    break;
                case 'logout':
                    await this.logoutCommand(sender, room, read, modify, persis);
                    break;
                case 'debug':
                    await this.debugCommand(sender, room, read, modify);
                    break;
                case 'help':
                default:
                    await this.helpCommand(sender, room, modify);
                    break;
            }
        } catch (error) {
            this.app.getLogger().error('Asana command error:', error);
            await this.sendNotification(modify, room, sender, `Error executing command: ${error.message}`);
        }
    }

    private async authCommand(sender: IUser, room: IRoom, read: IRead, modify: IModify): Promise<void> {
        try {
            // Check if OAuth service is initialized
            const oauth2Service = this.app.getOAuth2Service();
            if (!oauth2Service) {
                await this.sendNotification(modify, room, sender, 'Unable to access OAuth service. Please contact administrator to check application configuration.');
                return;
            }
            
            // Check if settings are configured
            const environmentReader = this.app.getAccessors().environmentReader;
            const clientId = await environmentReader.getSettings().getValueById('asana_client_id');
            const clientSecret = await environmentReader.getSettings().getValueById('asana_client_secret');
            const redirectUri = await environmentReader.getSettings().getValueById('asana_redirect_uri');
            
            this.app.getLogger().debug('Auth command settings check:', {
                clientIdSet: !!clientId,
                clientSecretSet: !!clientSecret,
                redirectUriSet: !!redirectUri
            });
            
            if (!clientId || !clientSecret || !redirectUri) {
                await this.sendNotification(modify, room, sender, 'Application is not fully configured. Please ensure that the administrator has configured Asana Client ID, Client Secret, and Redirect URI in the application settings.');
                return;
            }
            
            // Get authorization URL
            try {
                this.app.getLogger().debug('Requesting authorization URL for user:', sender.username);
                const authUrl = await oauth2Service.getUserAuthorizationUrl(sender);
                
                if (!authUrl) {
                    await this.sendNotification(modify, room, sender, 'Unable to generate authorization URL. Please contact administrator to check application configuration.');
                    return;
                }
                
                const message = `Please click the following link to authorize Asana integration: [Authorize Asana](${authUrl})`;
                await this.sendNotification(modify, room, sender, message);
                this.app.getLogger().debug('Authorization URL sent to user:', sender.username);
            } catch (urlError) {
                this.app.getLogger().error('Error getting authorization URL:', urlError);
                
                let errorMessage = 'Failed to get authorization URL';
                if (urlError && typeof urlError === 'object' && urlError.message) {
                    errorMessage = urlError.message;
                } else if (urlError) {
                    errorMessage = `${errorMessage}: ${urlError}`;
                }
                
                await this.sendNotification(modify, room, sender, errorMessage);
            }
        } catch (error) {
            this.app.getLogger().error('Auth command error:', error);
            
            // Provide more specific error information
            let errorMessage = 'An error occurred during the authorization process';
            
            if (error && typeof error === 'object' && error.message) {
                errorMessage = error.message;
            } else if (typeof error === 'string') {
                errorMessage = error;
            }
            
            if (errorMessage.includes('OAuth client not initialized')) {
                errorMessage = 'Authorization service not properly initialized. Please ensure that the administrator has configured Asana Client ID, Client Secret, and Redirect URI in the application settings, then re-enable the application.';
            }
            
            await this.sendNotification(modify, room, sender, errorMessage);
        }
    }

    private async tasksCommand(sender: IUser, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        try {
            const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(sender, read);
            
            if (!tokenInfo) {
                await this.sendNotification(modify, room, sender, 'You have not authorized Asana yet. Please run `/asana auth` command first.');
                return;
            }

            const apiService = this.app.getApiService();
            const tasks = await apiService.getUserTasks(tokenInfo.access_token, http) as AsanaTask[];
            
            if (!tasks || tasks.length === 0) {
                await this.sendNotification(modify, room, sender, 'No tasks found.');
                return;
            }

            // Sort tasks: incomplete first, then by due date
            const sortedTasks = [...tasks].sort((a, b) => {
                // First sort by completion status
                if (a.completed !== b.completed) {
                    return a.completed ? 1 : -1;
                }
                
                // Then sort by due date (if available)
                if (a.due_on && b.due_on) {
                    return new Date(a.due_on).getTime() - new Date(b.due_on).getTime();
                } else if (a.due_on) {
                    return -1;
                } else if (b.due_on) {
                    return 1;
                }
                
                return 0;
            });

            let message = '**Your Asana Tasks:**\n\n';
            
            // Group tasks by project
            const tasksByProject: Record<string, AsanaTask[]> = {};
            const tasksWithoutProject: AsanaTask[] = [];
            
            sortedTasks.forEach((task) => {
                if (task.projects && task.projects.length > 0) {
                    task.projects.forEach(project => {
                        if (!tasksByProject[project.name]) {
                            tasksByProject[project.name] = [];
                        }
                        tasksByProject[project.name].push(task);
                    });
                } else {
                    tasksWithoutProject.push(task);
                }
            });
            
            // Display tasks by project
            for (const [projectName, projectTasks] of Object.entries(tasksByProject)) {
                message += `**Project: ${projectName}**\n`;
                
                projectTasks.forEach((task) => {
                    // Build task link
                    let taskLink;
                    if (task.projects && task.projects.length > 0) {
                        taskLink = `https://app.asana.com/0/${task.projects[0].gid}/${task.gid}`;
                    } else {
                        taskLink = `https://app.asana.com/0/0/${task.gid}`;
                    }
                    
                    // Format due date if available
                    let dueInfo = '';
                    if (task.due_on) {
                        const dueDate = new Date(task.due_on);
                        const today = new Date();
                        const tomorrow = new Date(today);
                        tomorrow.setDate(today.getDate() + 1);
                        
                        // Check if due today or tomorrow
                        if (dueDate.toDateString() === today.toDateString()) {
                            dueInfo = ' - Due: **Today**';
                        } else if (dueDate.toDateString() === tomorrow.toDateString()) {
                            dueInfo = ' - Due: **Tomorrow**';
                        } else {
                            dueInfo = ` - Due: ${dueDate.toLocaleDateString()}`;
                        }
                    }
                    
                    // Add notes preview if available
                    let notesPreview = '';
                    if (task.notes && task.notes.trim()) {
                        const truncatedNotes = task.notes.length > 50 
                            ? task.notes.substring(0, 47) + '...' 
                            : task.notes;
                        notesPreview = ` - _${truncatedNotes}_`;
                    }
                    
                    message += `- [${task.name}](${taskLink}) ${task.completed ? '✅ Completed' : '⏳ In Progress'}${dueInfo}${notesPreview}\n`;
                });
                
                message += '\n';
            }
            
            // Display tasks without project
            if (tasksWithoutProject.length > 0) {
                message += '**Tasks without project:**\n';
                
                tasksWithoutProject.forEach((task) => {
                    const taskLink = `https://app.asana.com/0/0/${task.gid}`;
                    
                    // Format due date if available
                    let dueInfo = '';
                    if (task.due_on) {
                        const dueDate = new Date(task.due_on);
                        const today = new Date();
                        const tomorrow = new Date(today);
                        tomorrow.setDate(today.getDate() + 1);
                        
                        // Check if due today or tomorrow
                        if (dueDate.toDateString() === today.toDateString()) {
                            dueInfo = ' - Due: **Today**';
                        } else if (dueDate.toDateString() === tomorrow.toDateString()) {
                            dueInfo = ' - Due: **Tomorrow**';
                        } else {
                            dueInfo = ` - Due: ${dueDate.toLocaleDateString()}`;
                        }
                    }
                    
                    // Add notes preview if available
                    let notesPreview = '';
                    if (task.notes && task.notes.trim()) {
                        const truncatedNotes = task.notes.length > 50 
                            ? task.notes.substring(0, 47) + '...' 
                            : task.notes;
                        notesPreview = ` - _${truncatedNotes}_`;
                    }
                    
                    message += `- [${task.name}](${taskLink}) ${task.completed ? '✅ Completed' : '⏳ In Progress'}${dueInfo}${notesPreview}\n`;
                });
                
                message += '\n';
            }
            
            // Add summary
            message += `**Summary:** ${sortedTasks.filter(t => !t.completed).length} tasks in progress, ${sortedTasks.filter(t => t.completed).length} completed\n`;

            await this.sendNotification(modify, room, sender, message);
        } catch (error) {
            this.app.getLogger().error('Tasks command error:', error);
            await this.sendNotification(modify, room, sender, `Error getting tasks: ${error.message}`);
        }
    }

    private async projectsCommand(sender: IUser, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        try {
            const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(sender, read);
            
            if (!tokenInfo) {
                await this.sendNotification(modify, room, sender, 'You have not authorized Asana yet. Please run `/asana auth` command first.');
                return;
            }

            const apiService = this.app.getApiService();
            const projects = await apiService.getUserProjects(tokenInfo.access_token, http) as AsanaProject[];
            
            if (!projects || projects.length === 0) {
                await this.sendNotification(modify, room, sender, 'No projects found.');
                return;
            }

            let message = '**Your Asana Projects:**\n\n';
            projects.forEach((project) => {
                message += `- [${project.name}](https://app.asana.com/0/${project.gid}) - ${project.public ? 'Public' : 'Private'}\n`;
            });

            await this.sendNotification(modify, room, sender, message);
        } catch (error) {
            this.app.getLogger().error('Projects command error:', error);
            await this.sendNotification(modify, room, sender, `Error getting projects: ${error.message}`);
        }
    }

    private async taskCommand(sender: IUser, room: IRoom, taskId: string, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        try {
            const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(sender, read);
            
            if (!tokenInfo) {
                await this.sendNotification(modify, room, sender, 'You have not authorized Asana yet. Please run `/asana auth` command first.');
                return;
            }

            const apiService = this.app.getApiService();
            const task = await apiService.getTaskById(tokenInfo.access_token, taskId, http) as AsanaTask;
            
            if (!task) {
                await this.sendNotification(modify, room, sender, `Task with ID ${taskId} not found.`);
                return;
            }

            let message = `**Task Details: ${task.name}**\n\n`;
            message += `**Status:** ${task.completed ? '✅ Completed' : '⏳ In Progress'}\n`;
            
            if (task.due_on) {
                message += `**Due Date:** ${task.due_on}\n`;
            }
            
            if (task.assignee) {
                message += `**Assignee:** ${task.assignee.name}\n`;
            }
            
            if (task.projects && task.projects.length > 0) {
                message += `**Projects:** ${task.projects.map(p => p.name).join(', ')}\n`;
            }
            
            if (task.notes) {
                message += `\n**Description:**\n${task.notes}\n`;
            }
            
            // Build task link
            let taskLink;
            if (task.projects && task.projects.length > 0) {
                taskLink = `https://app.asana.com/0/${task.projects[0].gid}/${task.gid}`;
            } else {
                taskLink = `https://app.asana.com/0/0/${task.gid}`;
            }
            
            message += `\n[View in Asana](${taskLink})`;

            await this.sendNotification(modify, room, sender, message);
        } catch (error) {
            this.app.getLogger().error('Task command error:', error);
            await this.sendNotification(modify, room, sender, `Error getting task details: ${error.message}`);
        }
    }

    private async summaryCommand(sender: IUser, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        try {
            const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(sender, read);
            
            if (!tokenInfo) {
                await this.sendNotification(modify, room, sender, 'You have not authorized Asana yet. Please run `/asana auth` command first.');
                return;
            }

            const apiService = this.app.getApiService();
            const tasks = await apiService.getUserTasks(tokenInfo.access_token, http) as AsanaTask[];
            
            if (!tasks || tasks.length === 0) {
                await this.sendNotification(modify, room, sender, 'No tasks found.');
                return;
            }

            const completedTasks = tasks.filter(task => task.completed);
            const pendingTasks = tasks.filter(task => !task.completed);
            
            // Sort by due date
            const sortedPendingTasks = pendingTasks.sort((a, b) => {
                if (!a.due_on) return 1;
                if (!b.due_on) return -1;
                return new Date(a.due_on).getTime() - new Date(b.due_on).getTime();
            });
            
            // Find urgent tasks (due within 3 days)
            const today = new Date();
            const threeDaysLater = new Date();
            threeDaysLater.setDate(today.getDate() + 3);
            
            const urgentTasks = sortedPendingTasks.filter(task => {
                if (!task.due_on) return false;
                const dueDate = new Date(task.due_on);
                return dueDate <= threeDaysLater;
            });

            let message = '**Asana Task Summary**\n\n';
            message += `**Total Tasks:** ${tasks.length}\n`;
            message += `**Completed:** ${completedTasks.length}\n`;
            message += `**Pending:** ${pendingTasks.length}\n\n`;
            
            if (urgentTasks.length > 0) {
                message += '**Urgent Tasks:**\n';
                urgentTasks.forEach(task => {
                    // Build task link
                    let taskLink;
                    if (task.projects && task.projects.length > 0) {
                        taskLink = `https://app.asana.com/0/${task.projects[0].gid}/${task.gid}`;
                    } else {
                        taskLink = `https://app.asana.com/0/0/${task.gid}`;
                    }
                    
                    message += `- [${task.name}](${taskLink}) - Due Date: ${task.due_on}\n`;
                });
                message += '\n';
            }
            
            if (sortedPendingTasks.length > 0) {
                message += '**Next Tasks to Work On:**\n';
                // Only show top 5 tasks
                const topTasks = sortedPendingTasks.slice(0, 5);
                topTasks.forEach(task => {
                    // Build task link
                    let taskLink;
                    if (task.projects && task.projects.length > 0) {
                        taskLink = `https://app.asana.com/0/${task.projects[0].gid}/${task.gid}`;
                    } else {
                        taskLink = `https://app.asana.com/0/0/${task.gid}`;
                    }
                    
                    message += `- [${task.name}](${taskLink})${task.due_on ? ` - Due Date: ${task.due_on}` : ''}\n`;
                });
            }

            await this.sendNotification(modify, room, sender, message);
        } catch (error) {
            this.app.getLogger().error('Summary command error:', error);
            await this.sendNotification(modify, room, sender, `Error getting task summary: ${error.message}`);
        }
    }

    private async logoutCommand(sender: IUser, room: IRoom, read: IRead, modify: IModify, persis: IPersistence): Promise<void> {
        try {
            // 创建用户关联记录
            const association = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, sender.id);
            
            // 检查用户是否已授权
            const [tokenData] = await read.getPersistenceReader().readByAssociation(association);
            
            if (!tokenData) {
                await this.sendNotification(modify, room, sender, '您尚未授权Asana，无需注销。');
                return;
            }
            
            // 删除用户的授权令牌
            await persis.removeByAssociation(association);
            
            this.app.getLogger().info(`已删除用户 ${sender.username} 的Asana授权令牌`);
            await this.sendNotification(modify, room, sender, '您已成功注销Asana授权。您可以使用 `/asana auth` 命令重新授权。');
        } catch (error) {
            this.app.getLogger().error('Logout command error:', error);
            await this.sendNotification(modify, room, sender, `注销过程中出错: ${error.message}`);
        }
    }

    private async debugCommand(sender: IUser, room: IRoom, read: IRead, modify: IModify): Promise<void> {
        try {
            this.app.getLogger().debug(`Debug command executed by user: ${sender.username} (ID: ${sender.id})`);
            
            // Get all associated records for the user
            const userAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, sender.id);
            const records = await read.getPersistenceReader().readByAssociation(userAssociation);
            
            if (records && records.length > 0) {
                this.app.getLogger().debug(`Found ${records.length} records for user ${sender.username}:`, records);
                
                let message = `**Debug Information**\n\nUser: ${sender.username} (ID: ${sender.id})\n\nFound ${records.length} associated records:\n\n`;
                
                records.forEach((record, index) => {
                    message += `**Record ${index + 1}**:\n`;
                    message += `\`\`\`\n${JSON.stringify(record, null, 2)}\n\`\`\`\n\n`;
                });
                
                await this.sendNotification(modify, room, sender, message);
            } else {
                this.app.getLogger().debug(`No records found for user ${sender.username}`);
                await this.sendNotification(modify, room, sender, `No associated records found for user ${sender.username}`);
            }
        } catch (error) {
            this.app.getLogger().error('Debug command error:', error);
            await this.sendNotification(modify, room, sender, `Error getting debug information: ${error.message}`);
        }
    }

    private async webhookCommand(sender: IUser, room: IRoom, params: string[], read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        if (!params || params.length === 0) {
            await this.sendNotification(modify, room, sender, 'Please specify a webhook action: `create`, `list`, or `delete`');
            return;
        }

        const action = params[0].toLowerCase();
        const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(sender, read);
        
        if (!tokenInfo) {
            await this.sendNotification(modify, room, sender, 'You have not authorized Asana yet. Please run `/asana auth` command first.');
            return;
        }

        // const apiService = this.app.getApiService();

        switch (action) {
            case 'create':
                await this.createWebhook(sender, room, params.slice(1), tokenInfo.access_token, read, modify, http, persis);
                break;
            case 'list':
                await this.listWebhooks(sender, room, tokenInfo.access_token, read, modify, http);
                break;
            case 'delete':
                if (params.length < 2) {
                    await this.sendNotification(modify, room, sender, 'Please provide a webhook ID to delete: `/asana webhook delete <webhook_id>`');
                    return;
                }
                await this.deleteWebhook(sender, room, params[1], tokenInfo.access_token, read, modify, http, persis);
                break;
            default:
                await this.sendNotification(modify, room, sender, 'Invalid webhook action. Available actions: `create`, `list`, `delete`');
                break;
        }
    }

    private async createWebhook(sender: IUser, room: IRoom, params: string[], accessToken: string, read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        if (!params || params.length === 0) {
            await this.sendNotification(modify, room, sender, 'Please provide a resource ID (project or workspace ID): `/asana webhook create <resource_id>`');
            return;
        }

        const resourceId = params[0];
        const apiService = this.app.getApiService();

        // verify resource id format and length
        if (resourceId.length < 10) {
            await this.sendNotification(modify, room, sender, 'Invalid resource ID format. Too short for a valid resource ID.');
            return;
        }
        if (!/^\d+$/.test(resourceId)) {
            await this.sendNotification(modify, room, sender, 'Invalid resource ID format. Resource ID should be a numeric value.');
            return;
        }

        // get webhook URL
        let webhookUrl = '';
        try {
            const environmentReader = read.getEnvironmentReader();
            const serverSettings = environmentReader.getServerSettings(); 
            // TODO: add Site_Url to settings
            const siteUrl = await serverSettings.getValueById('Site_Url');
            this.app.getLogger().debug('Site_Url value:', siteUrl);
            
            if (!siteUrl) {
                this.app
                    .getLogger()
                    .warn(
                        "Site_Url setting is not configured, using fallback URL"
                    );
                // use fallback URL - should be replaced with actual server URL
                webhookUrl = `https://ccf1-168-4-66-238.ngrok-free.app/api/apps/public/${this.app.getID()}/webhook`;
                await this.sendNotification(
                    modify,
                    room,
                    sender,
                    "Warning: Server URL is not configured. Using fallback URL which may not work. Please set the Site_Url setting."
                );
            } else {
                const appId = this.app.getID();
                webhookUrl = `${siteUrl}/api/apps/public/${appId}/webhook`;
            }
        } catch (settingsError) {
            this.app.getLogger().error('Error getting server settings:', settingsError);
            // use fallback URL
            webhookUrl = `https://ccf1-168-4-66-238.ngrok-free.app/api/apps/public/${this.app.getID()}/webhook`;
            await this.sendNotification(modify, room, sender, 'Warning: Could not access server settings. Using fallback URL which may not work. Please contact your administrator.');
        }
        
        this.app.getLogger().debug('Using webhook URL:', webhookUrl);

        // verify resource id and permission
        try {
            // try fetch project info
            const projectResponse = await http.get(`https://app.asana.com/api/1.0/projects/${resourceId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                },
            });
            
            if (projectResponse.statusCode !== 200) {
                // if not project, try workspace
                const workspaceResponse = await http.get(`https://app.asana.com/api/1.0/workspaces/${resourceId}`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json',
                    },
                });
                
                if (workspaceResponse.statusCode !== 200) {
                    await this.sendNotification(modify, room, sender, `Resource ID ${resourceId} does not appear to be a valid project or workspace ID that you have access to.`);
                    return;
                }
            }
        } catch (validationError) {
            this.app.getLogger().error('Error validating resource ID:', validationError);
            await this.sendNotification(modify, room, sender, `Could not validate resource ID ${resourceId}. Please make sure it's a valid project or workspace ID and that you have access to it.`);
            return;
        }

        // create webhook
        let webhook;
        try {
            webhook = await apiService.createWebhook(accessToken, resourceId, webhookUrl, http);
            this.app.getLogger().debug('Webhook created successfully:', webhook);
        } catch (webhookError) {
            this.app.getLogger().error('Error from createWebhook API call:', webhookError);
            
            let errorMessage = 'Failed to create webhook.';
            
            // try to extract more useful error information
            if (webhookError instanceof Error) {
                const errorText = webhookError.message;
                
                if (errorText.includes('You do not have access to this resource')) {
                    errorMessage = `You don't have permission to create webhooks for resource ID: ${resourceId}. Please make sure:
1. You have admin access to this project or workspace
2. The resource ID is correct
3. Your Asana account has sufficient permissions`;
                } else if (errorText.includes('Invalid resource')) {
                    errorMessage = `Invalid resource ID: ${resourceId}. Please make sure this is a valid project or workspace ID.`;
                } else if (errorText.includes('permission')) {
                    errorMessage = `You don't have permission to create webhooks for resource: ${resourceId}.`;
                } else if (errorText.includes('already exists')) {
                    errorMessage = `A webhook for resource ${resourceId} already exists.`;
                } else {
                    errorMessage = `Error creating webhook: ${errorText}`;
                }
            }
            
            await this.sendNotification(modify, room, sender, errorMessage);
            return;
        }

        // if webhook created successfully, store the configuration
        if (webhook && webhook.gid) {
            try {
                // Store the webhook configuration in persistence
                const webhookAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `webhook_${webhook.gid}`);
                const userAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, sender.id);
                const roomAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.ROOM, room.id);

                const webhookData = {
                    webhookId: webhook.gid,
                    resourceId: resourceId,
                    createdBy: sender.id,
                    roomId: room.id,
                    createdAt: new Date().toISOString()
                };
                
                this.app.getLogger().debug('Storing webhook configuration:', webhookData);

                // 需要分开存储，因为createWithAssociations方法只接受单一关联
                await persis.createWithAssociation(webhookData, webhookAssociation);
                await persis.createWithAssociation(webhookData, userAssociation);
                await persis.createWithAssociation(webhookData, roomAssociation);
                
                // 同时保存用户的访问令牌作为admin_token，用于后续API调用
                const adminTokenAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, 'admin_token');
                await persis.updateByAssociation(adminTokenAssociation, { access_token: accessToken });
                this.app.getLogger().debug('Stored user token as admin token for future API calls');

                // 另外还将token与webhook关联，以支持多个webhook各自使用不同的token
                const webhookTokenAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `webhook_token_${webhook.gid}`);
                await persis.createWithAssociation({ access_token: accessToken }, webhookTokenAssociation);
                this.app.getLogger().debug(`Associated token with webhook ID: ${webhook.gid}`);

                // 创建从资源ID到webhook ID的映射关系
                const resourceWebhookMapAssociation = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    `resource_webhook_map_${resourceId}`
                );
                await persis.createWithAssociation({ webhookId: webhook.gid }, resourceWebhookMapAssociation);
                this.app.getLogger().debug(`创建了从资源ID ${resourceId} 到webhook ID ${webhook.gid} 的映射关系`);

                await this.sendNotification(modify, room, sender, `Webhook created successfully! Webhook ID: \`${webhook.gid}\`\nNotifications for resource \`${resourceId}\` will be sent to this room.`);
            } catch (persistError) {
                this.app.getLogger().error('Error storing webhook configuration:', persistError);
                await this.sendNotification(modify, room, sender, `Webhook was created with ID: \`${webhook.gid}\`, but there was an error storing the configuration. Notifications may not be properly routed.`);
            }
        } else {
            await this.sendNotification(modify, room, sender, 'Webhook creation failed: Invalid response from Asana API.');
        }
    }

    private async listWebhooks(sender: IUser, room: IRoom, accessToken: string, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        const apiService = this.app.getApiService();
        
        // Get user's workspaces
        const workspaces = await apiService.getWorkspaces(accessToken, http);
        
        if (!workspaces || workspaces.length === 0) {
            await this.sendNotification(modify, room, sender, 'No workspaces found.');
            return;
        }

        // Get webhooks for each workspace
        let allWebhooks: any[] = [];
        for (const workspace of workspaces) {
            const webhooks = await apiService.getWebhooks(accessToken, workspace.gid, http);
            if (webhooks && webhooks.length > 0) {
                allWebhooks = [...allWebhooks, ...webhooks.map(webhook => ({
                    ...webhook,
                    workspace: workspace.name
                }))];
            }
        }

        if (allWebhooks.length === 0) {
            await this.sendNotification(modify, room, sender, 'No webhooks found.');
            return;
        }

        // Get webhook configurations from persistence
        const userAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, sender.id);
        const webhookConfigs = await read.getPersistenceReader().readByAssociation(userAssociation);

        // Build message
        let message = '*Your Asana Webhooks:*\n\n';
        
        allWebhooks.forEach((webhook) => {
            // Find configuration for this webhook
            const config = webhookConfigs?.find((config: any) => config.webhookId === webhook.gid) as { roomId: string } | undefined;
            const roomInfo = config ? `Room: ${config.roomId}` : 'Not configured for any room';
            
            message += `- **ID:** \`${webhook.gid}\`\n`;
            // make resource name the bullet point of the resource id
            message += `- **Resource:** \`${webhook.resource.gid}\` (${webhook.resource.name || 'Unknown'})\n`;
            message += `- **Workspace:** ${webhook.workspace}\n`;
            message += `- **Active:** ${webhook.active ? 'Yes' : 'No'}\n`;
            message += `- **${roomInfo}**\n\n`;
        });

        message += `Total webhooks: ${allWebhooks.length}`;

        await this.sendNotification(modify, room, sender, message);
    }

    private async deleteWebhook(sender: IUser, room: IRoom, webhookId: string, accessToken: string, read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        const apiService = this.app.getApiService();
        
        // Delete the webhook from Asana
        const success = await apiService.deleteWebhook(accessToken, webhookId, http);
        
        if (!success) {
            await this.sendNotification(modify, room, sender, `Failed to delete webhook \`${webhookId}\`. Please check the webhook ID and try again.`);
            return;
        }

        // Remove the webhook configuration from persistence
        const webhookAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, `webhook_${webhookId}`);
        await persis.removeByAssociation(webhookAssociation);

        await this.sendNotification(modify, room, sender, `Webhook \`${webhookId}\` deleted successfully.`);
    }

    private async helpCommand(sender: IUser, room: IRoom, modify: IModify): Promise<void> {
        const message = `
**Asana Integration Help**

Available commands:
- \`/asana auth\` - Authorize app to access your Asana account
- \`/asana tasks\` - List your Asana tasks
- \`/asana projects\` - List your Asana projects  
- \`/asana task <task_id>\` - Show details of a specific task
- \`/asana summary\` - Show summary of your Asana tasks
- \`/asana webhook create <resource_id>\` - Create a webhook for a project or workspace
- \`/asana webhook list\` - List all your webhooks
- \`/asana webhook delete <webhook_id>\` - Delete a webhook
- \`/asana logout\` - Logout and remove your Asana authorization
- \`/asana help\` - Show this help message
`;
        await this.sendNotification(modify, room, sender, message);
    }

    private async sendNotification(modify: IModify, room: IRoom, sender: IUser, message: string): Promise<void> {
        const notifier = modify.getNotifier();
        const messageBuilder = notifier.getMessageBuilder();
        
        messageBuilder
            .setRoom(room)
            .setSender(sender)
            .setParseUrls(true)
            .setText(message);
        
        await notifier.notifyUser(sender, messageBuilder.getMessage());
    }
} 