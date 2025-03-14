import { IHttp, IModify, IPersistence, IRead, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiEndpoint, IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { AsanaOAuth2Service } from '../lib/AsanaOAuth2Service';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { AsanaIntegrationApp } from '../AsanaIntegrationApp';

// 定义一个接口，包含我们需要的方法
interface IAsanaApp extends App {
    getLogger(): ILogger;
    getOAuth2Service(): AsanaOAuth2Service;
}

export class AsanaOAuthEndpoint extends ApiEndpoint {
    public path = 'oauth-callback';

    constructor(public readonly app: IAsanaApp) {
        super(app);
    }

    public async get(
        request: IApiRequest,
        endpoint: IApiEndpointInfo,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persis: IPersistence
    ): Promise<IApiResponse> {
        const { code, state, error } = request.query;
        
        this.app.getLogger().debug('OAuth callback received:', {
            hasCode: !!code,
            hasState: !!state,
            state: state,
            error: error || 'none',
            fullQuery: request.query
        });
        
        // 检查是否有错误
        if (error) {
            this.app.getLogger().error('OAuth error returned from Asana:', error);
            return this.success({
                status: 'error',
                message: `Asana authorization failed: ${error}`,
            });
        }
        
        if (!code) {
            this.app.getLogger().error('Missing required code parameter');
            return this.success({
                status: 'error',
                message: 'Missing required parameter (code)',
            });
        }

        try {
            // 尝试从 state 参数中获取用户 ID
            let actualUser: IUser | undefined = undefined;
            if (state) {
                actualUser = await this.findUserByState(state, read);
            }
            
            // 如果无法从 state 中获取用户，则使用应用用户作为后备
            if (!actualUser) {
                this.app.getLogger().warn('Could not find user from state, falling back to app user');
                actualUser = await this.app.getAccessors().reader.getUserReader().getAppUser();
            }
            
            if (!actualUser) {
                this.app.getLogger().error('No user found for OAuth callback');
                return this.success({
                    status: 'error',
                    message: 'Unable to determine user identity. Please contact administrator.',
                });
            }

            this.app.getLogger().debug(`Using user for OAuth callback: ${actualUser.username}`);

            // 处理OAuth回调
            const oauth2Service = this.app.getOAuth2Service();
            
            if (!oauth2Service) {
                this.app.getLogger().error('OAuth2 service not available');
                return this.success({
                    status: 'error',
                    message: 'Authorization service unavailable. Please contact administrator.',
                });
            }
            
            try {
                // 使用实际用户处理回调
                const success = await oauth2Service.handleOAuthCallback(actualUser, code, state || '', read, http, persis);
                
                if (success) {
                    // 发送成功消息给用户
                    await this.sendSuccessMessage(actualUser, modify);
                    
                    return this.success({
                        status: 'success',
                        message: 'Authorization successful! You can close this window and return to Rocket.Chat.',
                    });
                } else {
                    this.app.getLogger().error('OAuth callback handling failed');
                    return this.success({
                        status: 'error',
                        message: 'Authorization processing failed, please try again.',
                    });
                }
            } catch (callbackError) {
                this.app.getLogger().error('Error in OAuth callback handling:', callbackError);
                return this.success({
                    status: 'error',
                    message: 'Error processing authorization callback',
                    error: callbackError.message || 'Unknown error',
                });
            }
        } catch (error) {
            this.app.getLogger().error('OAuth callback processing error:', error);
            
            let errorMessage = 'Error occurred during authorization';
            if (error && typeof error === 'object' && error.message) {
                errorMessage += `: ${error.message}`;
            }
            
            return this.success({
                status: 'error',
                message: errorMessage,
            });
        }
    }

    public async post(
        request: IApiRequest,
        endpoint: IApiEndpointInfo,
        read: IRead,
        modify: IModify,
        http: IHttp,
        persis: IPersistence
    ): Promise<IApiResponse> {
        // 如果不需要POST请求，可以返回错误
        return this.success({
            status: 'error',
            message: 'Method not supported',
        });
    }

    private async findUserByState(state: string, read: IRead): Promise<IUser | undefined> {
        try {
            this.app.getLogger().debug('Finding user by state:', state);
            
            // 尝试解析 state 格式
            // 新格式: "userId_randomString"
            const parts = state.split('_');
            this.app.getLogger().debug(`State parts: ${JSON.stringify(parts)}`);
            
            if (parts.length > 0) {
                const userId = parts[0];
                this.app.getLogger().debug(`Extracted user ID from state: ${userId}`);
                
                // 尝试通过 ID 查找用户
                const user = await read.getUserReader().getById(userId);
                if (user) {
                    this.app.getLogger().debug(`Found user by ID from state: ${user.username} (ID: ${user.id})`);
                    return user;
                } else {
                    this.app.getLogger().debug(`No user found with ID: ${userId}`);
                }
            }
            
            // 如果上述方法失败，尝试其他方法
            
            // 获取当前用户
            const appUser = await this.app.getAccessors().reader.getUserReader().getAppUser();
            if (appUser) {
                this.app.getLogger().debug('Using app user as fallback:', appUser.username);
                return appUser;
            }
            
            // 尝试获取管理员用户
            const adminUser = await read.getUserReader().getByUsername('admin');
            if (adminUser) {
                this.app.getLogger().debug('Using admin user as fallback:', adminUser.username);
                return adminUser;
            }
            
            this.app.getLogger().warn('No user found for state:', state);
            return undefined;
        } catch (error) {
            this.app.getLogger().error('Error finding user by state:', error);
            return undefined;
        }
    }

    private async sendSuccessMessage(user: IUser, modify: IModify): Promise<void> {
        try {
            // 获取应用用户
            const appUser = await this.app.getAccessors().reader.getUserReader().getAppUser();
            if (!appUser) {
                return;
            }

            // 直接向用户发送通知
            const messageText = '✅ You have successfully authorized the Asana integration! Now you can use the `/asana` command to access your Asana tasks and projects.';
            
            await modify.getNotifier().notifyUser(
                user,
                modify.getCreator().startMessage()
                    .setSender(appUser)
                    .setText(messageText)
                    .setUsernameAlias('Asana Integration')
                    .getMessage()
            );
        } catch (error) {
            this.app.getLogger().error('Error sending success message:', error);
        }
    }
}

export default AsanaOAuthEndpoint; 