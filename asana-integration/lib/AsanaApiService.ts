import { IHttp, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiVisibility, ApiSecurity } from '@rocket.chat/apps-engine/definition/api';
import { HttpStatusCode } from '@rocket.chat/apps-engine/definition/accessors';

interface IAsanaApp {
    getLogger(): ILogger;
}

export class AsanaApiService {
    private readonly baseUrl = 'https://app.asana.com/api/1.0';
    private readonly logger: ILogger;

    constructor(private readonly app: IAsanaApp) {
        this.logger = this.app.getLogger();
    }

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
                this.logger.error('Failed to get user:', response.content);
                return null;
            }
        } catch (error) {
            this.logger.error('Error getting user:', error);
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
                this.logger.error('Failed to get workspaces:', workspacesResponse.content);
                return [];
            }

            const workspaces = workspacesResponse.data.data;
            if (!workspaces || workspaces.length === 0) {
                this.logger.error('No workspaces found');
                return [];
            }

            // Use the first workspace
            const workspaceId = workspaces[0].gid;
            this.logger.debug(`Using workspace: ${workspaces[0].name} (ID: ${workspaceId})`);

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
                this.logger.error('Failed to get tasks:', response.content);
                return [];
            }
        } catch (error) {
            this.logger.error('Error getting tasks:', error);
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
                this.logger.error('Failed to get workspaces:', workspacesResponse.content);
                return [];
            }

            const workspaces = workspacesResponse.data.data;
            if (!workspaces || workspaces.length === 0) {
                this.logger.error('No workspaces found');
                return [];
            }

            // Use the first workspace
            const workspaceId = workspaces[0].gid;
            this.logger.debug(`Using workspace for projects: ${workspaces[0].name} (ID: ${workspaceId})`);

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
                this.logger.error('Failed to get projects:', response.content);
                return [];
            }
        } catch (error) {
            this.logger.error('Error getting projects:', error);
            return [];
        }
    }

    /**
     * Get specific task details
     */
    public async getTaskById(accessToken: string, taskId: string, http: IHttp): Promise<any> {
        if (!accessToken || !taskId) {
            this.logger.debug('getTaskById: missing access token or task ID');
            return null;
        }

        try {
            const response = await http.get(`${this.baseUrl}/tasks/${taskId}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json',
                },
                params: {
                    opt_fields: 'name,completed,due_on,assignee,projects,notes,html_notes,workspace,memberships,parent,tags'
                }
            });

            if (response.statusCode === HttpStatusCode.OK && response.data && response.data.data) {
                if (response.data.data.projects) {
                    response.data.data.projects.forEach((project: any) => {
                        this.logger.debug(`Project: ${project.name}, Project ID: ${project.gid}`);
                    });
                }
                return response.data.data;
            } else {
                this.logger.error(`getTaskById failed: ${response.statusCode}`);
                return null;
            }
        } catch (error) {
            this.logger.error(`getTaskById failed: ${error}`);
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
                this.logger.error(`Failed to get tasks for project ${projectId}:`, response.content);
                return [];
            }
        } catch (error) {
            this.logger.error(`Error getting tasks for project ${projectId}:`, error);
            return [];
        }
    }

    /**
     * Create Webhook
     */
    public async createWebhook(accessToken: string, resourceId: string, target: string, http: IHttp): Promise<any> {
        if (!accessToken) {
            this.logger.error('No access token provided for createWebhook');
            throw new Error('Authentication required: No access token provided');
        }

        if (!resourceId) {
            this.logger.error('No resource ID provided for createWebhook');
            throw new Error('Resource ID is required');
        }

        if (!target) {
            this.logger.error('No target URL provided for createWebhook');
            throw new Error('Target URL is required');
        }

        try {
            this.logger.debug('Creating webhook with params:', {
                resourceId,
                target,
                accessToken: accessToken ? '***' : 'undefined'
            });

            // Asana API request body
            const requestBody = {
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
                        {
                            resource_type: 'task',
                            action: 'deleted',
                        },
                        {
                            resource_type: 'task',
                            action: 'undeleted',
                        },
                    ],
                }
            };

            // build request options
            const requestOptions = {
                headers: this.getAuthHeaders(accessToken),
                data: requestBody,
            };

            try {
                // directly use try-catch to wrap HTTP request
                const response = await http.post(`${this.baseUrl}/webhooks`, requestOptions);
                
                // try to parse response content
                let responseData;
                if (response.data) {
                    responseData = response.data;
                } else if (typeof response.content === 'string') {
                    try {
                        responseData = JSON.parse(response.content);
                    } catch (parseError) {
                        this.logger.error('Failed to parse response content:', parseError);
                    }
                }

                this.logger.debug('Parsed response data:', responseData ? JSON.stringify(responseData).substring(0, 500) : 'null');

                if (response.statusCode === 201 && responseData && responseData.data) {
                    return responseData.data;
                } else {
                    // try to extract error information
                    let errorDetail = '';
                    if (responseData && responseData.errors) {
                        errorDetail = JSON.stringify(responseData.errors);
                    } else {
                        errorDetail = response.content || 'Unknown error';
                    }

                    this.logger.error('Failed to create webhook:', {
                        statusCode: response.statusCode,
                        errorDetail: typeof errorDetail === 'string' ? errorDetail.substring(0, 500) : JSON.stringify(errorDetail).substring(0, 500)
                    });
                    
                    throw new Error(`API returned status ${response.statusCode}: ${errorDetail}`);
                }
            } catch (httpError) {
                this.logger.error('HTTP request error:', httpError);
                if (httpError.response) {
                    this.logger.error('HTTP response details:', {
                        status: httpError.response.status,
                        statusText: httpError.response.statusText,
                        data: httpError.response.data
                    });
                }
                throw new Error(`HTTP request failed: ${httpError.message || 'Unknown error'}`);
            }
        } catch (error) {
            this.logger.error('Error creating webhook:', error);
            if (error instanceof Error) {
                this.logger.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
            } else {
                this.logger.error('Non-Error object thrown:', JSON.stringify(error));
            }
            throw error;
        }
    }

    /**
     * Get Webhooks
     */
    public async getWebhooks(accessToken: string, workspaceId: string, http: IHttp): Promise<any[]> {
        try {
            const response = await http.get(`${this.baseUrl}/webhooks`, {
                headers: this.getAuthHeaders(accessToken),
                params: {
                    workspace: workspaceId,
                    limit: '100',
                },
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.logger.error('Failed to get webhooks:', response.content);
                return [];
            }
        } catch (error) {
            this.logger.error('Error getting webhooks:', error);
            return [];
        }
    }

    /**
     * Delete Webhook
     */
    public async deleteWebhook(accessToken: string, webhookId: string, http: IHttp): Promise<boolean> {
        try {
            const response = await http.del(`${this.baseUrl}/webhooks/${webhookId}`, {
                headers: this.getAuthHeaders(accessToken),
            });

            if (response.statusCode === 200) {
                return true;
            } else {
                this.logger.error(`Failed to delete webhook ${webhookId}:`, response.content);
                return false;
            }
        } catch (error) {
            this.logger.error(`Error deleting webhook ${webhookId}:`, error);
            return false;
        }
    }

    /**
     * Get Workspaces
     */
    public async getWorkspaces(accessToken: string, http: IHttp): Promise<any[]> {
        try {
            const response = await http.get(`${this.baseUrl}/workspaces`, {
                headers: this.getAuthHeaders(accessToken),
            });

            if (response.statusCode === 200 && response.data) {
                return response.data.data;
            } else {
                this.logger.error('Failed to get workspaces:', response.content);
                return [];
            }
        } catch (error) {
            this.logger.error('Error getting workspaces:', error);
            return [];
        }
    }

    /**
     * Get specific project details
     */
    public async getProjectById(accessToken: string, projectId: string, http: IHttp): Promise<any> {
        try {
            const response = await http.get(`${this.baseUrl}/projects/${projectId}`, {
                headers: this.getAuthHeaders(accessToken),
                params: {
                    opt_fields: 'name,notes,archived,owner,workspace',
                },
            });

            if (response.statusCode === 200 && response.data) {
                // log project details
                this.logger.debug(`Project details: ${JSON.stringify(response.data.data)}`);
                return response.data.data;
            } else {
                this.logger.error(`Failed to get project ${projectId}:`, response.content);
                return null;
            }
        } catch (error) {
            this.logger.error(`Error getting project ${projectId}:`, error);
            return null;
        }
    }

    /**
     * Get user details by user ID
     * @param accessToken Access token for API authentication
     * @param userId User ID to look up, can be "me", email, or user gid
     * @param http HTTP service for making requests
     * @returns User details or null if not found
     */
    public async getUserById(accessToken: string, userId: string, http: IHttp): Promise<any> {
        if (!accessToken) {
            this.logger.error('getUserById: no access token provided');
            return null;
        }
        
        if (!userId) {
            this.logger.error('getUserById: no user ID provided');
            return null;
        }

        try {
            // full request URL and detailed logs
            const requestUrl = `${this.baseUrl}/users/${userId}`;
            
            const headers = {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            };
            
            const params = {
                opt_fields: 'name,email,photo,workspaces'
            };

            const response = await http.get(requestUrl, {
                headers: headers,
                params: params
            });
            
            if (response.statusCode === HttpStatusCode.OK) {
                if (response.data && response.data.data) {
                    const userData = response.data.data;
                    this.logger.debug(`successfully got user data: ${userData.name || 'unknown name'}, email: ${userData.email || 'no email provided'}`);
                    return userData;
                } else {
                    this.logger.error(`API returned 200 status code, but no user data`);
                    return null;
                }
            } else {
                this.logger.error(`failed to get user, status code: ${response.statusCode}`);
                return null;
            }
        } catch (error) {
            this.logger.error(`error getting user: ${error}`);
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