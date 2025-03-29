import { IHttp, IModify, IPersistence, IRead, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiEndpoint, IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { AsanaOAuth2Service } from '../lib/AsanaOAuth2Service';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';

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
        const { code, state, error} = request.query;

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
            let actualUser: IUser | undefined = undefined;
            if (state) {
                actualUser = await this.findUserByState(state, read);
            }
            
            if (!actualUser) {
                this.app.getLogger().error('No user found for OAuth callback');
                return this.success({
                    status: 'error',
                    message: 'Unable to determine user identity. Please contact administrator.',
                });
            }

            const roomId = state.split("_")[1];
            const room = await read.getRoomReader().getById(roomId);
            if (!room) {
                this.app.getLogger().error('Room not found');
                return this.success({
                    status: 'error',
                    message: 'Room not found',
                });
            }

            // handle oauth callback
            const oauth2Service = this.app.getOAuth2Service();
            
            if (!oauth2Service) {
                this.app.getLogger().error('OAuth2 service not available');
                return this.success({
                    status: 'error',
                    message: 'Authorization service unavailable. Please contact administrator.',
                });
            }

            try {
                const success = await oauth2Service.handleOAuthCallback(actualUser, code, state || '', read, http, persis);
                
                if (success) {
                    await this.sendSuccessMessage(actualUser, modify, room);
                    
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
        return this.success({
            status: 'error',
            message: 'Method not supported',
        });
    }

    private async findUserByState(state: string, read: IRead): Promise<IUser | undefined> {
        try {
            // extract user id from state: "userId_randomString"
            const parts = state.split('_');
            
            if (parts.length > 0) {
                const userId = parts[0];
                this.app.getLogger().debug(`Extracted user ID from state: ${userId}`);
                
                // try to find user by id
                const user = await read.getUserReader().getById(userId);
                if (user) {
                    this.app.getLogger().debug(`Found user by ID from state: ${user.username} (ID: ${user.id})`);
                    return user;
                } else {
                    this.app.getLogger().debug(`No user found with ID: ${userId}`);
                }
            }
            
            const appUser = await this.app.getAccessors().reader.getUserReader().getAppUser();
            if (appUser) {
                this.app.getLogger().debug('Using app user as fallback:', appUser.username);
                return appUser;
            }
                        
            return undefined;
        } catch (error) {
            this.app.getLogger().error('Error finding user by state:', error);
            return undefined;
        }
    }

    private async sendSuccessMessage(user: IUser, modify: IModify, room: IRoom): Promise<void> {
        try {
            // get app user
            const appUser = await this.app
                .getAccessors()
                .reader.getUserReader()
                .getAppUser();
            if (!appUser) {
                return;
            }
            // send success message to user
            const messageText =
                "✅ You have successfully authorized the Asana integration! Now you can use the `/asana` command to access your Asana tasks and projects.";

            const messageBuilder = modify
                .getCreator()
                .startMessage()
                .setRoom(room)
                .setSender(appUser)
                .setText(messageText);

            await modify.getCreator().finish(messageBuilder);
        } catch (error) {
            this.app.getLogger().error('Error sending success message:', error);
        }
    }
}

export default AsanaOAuthEndpoint; 