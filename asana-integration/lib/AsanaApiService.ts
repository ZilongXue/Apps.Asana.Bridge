import { IHttp, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiVisibility, ApiSecurity } from '@rocket.chat/apps-engine/definition/api';

// Define an interface with the methods we need
interface IAsanaApp {
    getLogger(): ILogger;
}

export class AsanaApiService {
    private readonly baseUrl = 'https://app.asana.com/api/1.0';

    constructor(private readonly app: IAsanaApp) {}

    /**
     * Get current user information
     */
    public async getUser(accessToken: string, http: IHttp): Promise<any> {
        try {
            const response = await http.get(`${this.baseUrl}/users/me`, {
                headers: this.getAuthHeaders(accessToken),
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.app.getLogger().error('Failed to get user:', response.content);
                return null;
            }
        } catch (error) {
            this.app.getLogger().error('Error getting user:', error);
            return null;
        }
    }

    /**
     * Get user's tasks
     */
    public async getUserTasks(accessToken: string, http: IHttp): Promise<any[]> {
        try {
            // First get user's workspaces
            const workspacesResponse = await http.get(`${this.baseUrl}/workspaces`, {
                headers: this.getAuthHeaders(accessToken),
            });

            if (workspacesResponse.statusCode !== 200 || !workspacesResponse.data) {
                this.app.getLogger().error('Failed to get workspaces:', workspacesResponse.content);
                return [];
            }

            const workspaces = workspacesResponse.data.data;
            if (!workspaces || workspaces.length === 0) {
                this.app.getLogger().error('No workspaces found');
                return [];
            }

            // Use the first workspace
            const workspaceId = workspaces[0].gid;
            this.app.getLogger().debug(`Using workspace: ${workspaces[0].name} (ID: ${workspaceId})`);

            // Get tasks assigned to the user in the workspace
            const response = await http.get(`${this.baseUrl}/tasks`, {
                headers: this.getAuthHeaders(accessToken),
                params: {
                    assignee: 'me',
                    workspace: workspaceId,
                    opt_fields: 'name,completed,due_on,projects,projects.name,assignee,notes,created_at,modified_at,custom_fields,html_notes',
                    limit: '100',
                },
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.app.getLogger().error('Failed to get tasks:', response.content);
                return [];
            }
        } catch (error) {
            this.app.getLogger().error('Error getting tasks:', error);
            return [];
        }
    }

    /**
     * Get user's projects
     */
    public async getUserProjects(accessToken: string, http: IHttp): Promise<any[]> {
        try {
            // First get user's workspaces
            const workspacesResponse = await http.get(`${this.baseUrl}/workspaces`, {
                headers: this.getAuthHeaders(accessToken),
            });

            if (workspacesResponse.statusCode !== 200 || !workspacesResponse.data) {
                this.app.getLogger().error('Failed to get workspaces:', workspacesResponse.content);
                return [];
            }

            const workspaces = workspacesResponse.data.data;
            if (!workspaces || workspaces.length === 0) {
                this.app.getLogger().error('No workspaces found');
                return [];
            }

            // Use the first workspace
            const workspaceId = workspaces[0].gid;
            this.app.getLogger().debug(`Using workspace for projects: ${workspaces[0].name} (ID: ${workspaceId})`);

            // Get projects in the workspace
            const response = await http.get(`${this.baseUrl}/projects`, {
                headers: this.getAuthHeaders(accessToken),
                params: {
                    workspace: workspaceId,
                    opt_fields: 'name,owner,notes',
                    limit: '100',
                },
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.app.getLogger().error('Failed to get projects:', response.content);
                return [];
            }
        } catch (error) {
            this.app.getLogger().error('Error getting projects:', error);
            return [];
        }
    }

    /**
     * Get specific task details
     */
    public async getTaskById(accessToken: string, taskId: string, http: IHttp): Promise<any> {
        try {
            const response = await http.get(`${this.baseUrl}/tasks/${taskId}`, {
                headers: this.getAuthHeaders(accessToken),
                params: {
                    opt_fields: 'name,notes,completed,due_on,assignee,projects',
                },
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.app.getLogger().error(`Failed to get task ${taskId}:`, response.content);
                return null;
            }
        } catch (error) {
            this.app.getLogger().error(`Error getting task ${taskId}:`, error);
            return null;
        }
    }

    /**
     * Get project tasks
     */
    public async getProjectTasks(accessToken: string, projectId: string, http: IHttp): Promise<any[]> {
        try {
            const response = await http.get(`${this.baseUrl}/projects/${projectId}/tasks`, {
                headers: this.getAuthHeaders(accessToken),
                params: {
                    opt_fields: 'name,completed,due_on,assignee',
                    limit: '100',
                },
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.app.getLogger().error(`Failed to get tasks for project ${projectId}:`, response.content);
                return [];
            }
        } catch (error) {
            this.app.getLogger().error(`Error getting tasks for project ${projectId}:`, error);
            return [];
        }
    }

    /**
     * Create Webhook
     */
    public async createWebhook(accessToken: string, resourceId: string, target: string, http: IHttp): Promise<any> {
        try {
            const response = await http.post(`${this.baseUrl}/webhooks`, {
                headers: this.getAuthHeaders(accessToken),
                data: {
                    data: {
                        resource: resourceId,
                        target,
                        filters: [
                            {
                                resource_type: 'task',
                                action: 'changed',
                            },
                            {
                                resource_type: 'task',
                                action: 'added',
                            },
                            {
                                resource_type: 'task',
                                action: 'removed',
                            },
                        ],
                    },
                },
            });

            if (response.statusCode === 201 && response.data) {
                return response.data.data;
            } else {
                this.app.getLogger().error('Failed to create webhook:', response.content);
                return null;
            }
        } catch (error) {
            this.app.getLogger().error('Error creating webhook:', error);
            return null;
        }
    }

    /**
     * Get authorization header information
     */
    private getAuthHeaders(accessToken: string): { [key: string]: string } {
        return {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
        };
    }
}

// Add default export
export default AsanaApiService; 