import { IConfigurationExtend, IHttp, IPersistence, IRead, IModify, ILogger } from '@rocket.chat/apps-engine/definition/accessors';
import { IUser } from '@rocket.chat/apps-engine/definition/users';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { AppSetting } from '../settings/Settings';
import { IOAuth2Client } from '@rocket.chat/apps-engine/definition/oauth2/IOAuth2';
import { createOAuth2Client } from '@rocket.chat/apps-engine/definition/oauth2/OAuth2';
import { IAuthData } from '@rocket.chat/apps-engine/definition/oauth2/IOAuth2';
import { App } from '@rocket.chat/apps-engine/definition/App';

export class AsanaOAuth2Service {
    private oauthClient: IOAuth2Client;

    constructor(private readonly app: App) {
        // OAuth2 client will be initialized in setup
    }

    public async setup(configuration: IConfigurationExtend): Promise<void> {
        try {
            // Get settings from environment
            const environmentReader = this.app.getAccessors().environmentReader;
            const clientId = await environmentReader.getSettings().getValueById(AppSetting.AsanaClientId);
            const clientSecret = await environmentReader.getSettings().getValueById(AppSetting.AsanaClientSecret);
            const redirectUri = await environmentReader.getSettings().getValueById(AppSetting.AsanaRedirectUri);

            this.app.getLogger().debug('OAuth2 setup - Settings retrieved:', { 
                clientIdSet: !!clientId, 
                clientSecretSet: !!clientSecret, 
                redirectUriSet: !!redirectUri 
            });

            if (!clientId || !clientSecret || !redirectUri) {
                this.app.getLogger().warn('Asana OAuth settings not configured yet. Please configure Client ID, Client Secret, and Redirect URI in app settings.');
                return;
            }

            // Create OAuth2 client with Asana configuration
            const oauthConfig = {
                alias: 'asana',
                clientId,
                clientSecret,
                redirectUri,
                accessTokenUri: 'https://app.asana.com/-/oauth_token',
                authUri: 'https://app.asana.com/-/oauth_authorize',
                refreshTokenUri: 'https://app.asana.com/-/oauth_token',
                revokeTokenUri: 'https://app.asana.com/-/oauth_revoke',
                defaultScopes: ['default'],
                authorizationCallback: async (token: IAuthData | undefined, user: IUser, read: IRead, modify: IModify, http: IHttp, persis: IPersistence) => {
                    // Handle authorization callback
                    this.app.getLogger().debug(`Authorization callback for user: ${user.username}`);
                    return { responseContent: 'Authorization successful! You can close this window and return to Rocket.Chat.' };
                },
            };

            try {
                this.app.getLogger().debug('Creating OAuth2 client with config:', {
                    alias: oauthConfig.alias,
                    clientIdProvided: !!oauthConfig.clientId,
                    clientSecretProvided: !!oauthConfig.clientSecret,
                    redirectUriProvided: !!oauthConfig.redirectUri,
                    scopes: oauthConfig.defaultScopes
                });
                
                this.oauthClient = createOAuth2Client(this.app, oauthConfig);
                
                if (!this.oauthClient) {
                    throw new Error('Failed to create OAuth2 client');
                }
                
                await this.oauthClient.setup(configuration);
                this.app.getLogger().debug('AsanaOAuth2Service setup completed successfully');
            } catch (setupError) {
                this.app.getLogger().error('Error setting up OAuth2 client:', setupError);
                throw new Error(`OAuth2 client setup failed: ${setupError.message || JSON.stringify(setupError)}`);
            }
        } catch (error) {
            this.app.getLogger().error('AsanaOAuth2Service setup error:', error);
            throw error; // Re-throw the error so the caller knows there was a problem
        }
    }

    public async getUserAuthorizationUrl(user: IUser): Promise<string> {
        try {
            if (!this.oauthClient) {
                throw new Error('OAuth client not initialized');
            }
            
            // Add more logs
            this.app.getLogger().debug(`Attempting to get authorization URL for user ${user.username}`);
            
            // Directly build URL using built-in methods, not relying on oauthClient
            const environmentReader = this.app.getAccessors().environmentReader;
            const clientId = await environmentReader.getSettings().getValueById('asana_client_id');
            const redirectUri = await environmentReader.getSettings().getValueById('asana_redirect_uri');
            
            if (!clientId || !redirectUri) {
                throw new Error('Missing required OAuth configuration (Client ID or Redirect URI)');
            }
            
            // Check if redirect URI is correct
            if (!redirectUri) {
                this.app.getLogger().error('Redirect URI is not set');
                return '';
            }

            // Check if redirect URI contains special characters or encoding issues
            this.app.getLogger().debug('Checking redirect URI:', {
                redirectUri,
                length: redirectUri.length,
                containsEncodedChars: redirectUri.includes('%')
            });
            
            // Generate random state - using a simple random string without user ID
            // This avoids exposing user ID in the callback URL
            const state = `${user.id}_${Math.random().toString(36).substring(2, 15)}`;
            this.app.getLogger().debug(`Generated state for user ${user.username} (ID: ${user.id}): ${state}`);
            
            // Build authorization URL
            const authUrl = new URL('https://app.asana.com/-/oauth_authorize');
            authUrl.searchParams.append('client_id', clientId);

            // Ensure redirect URI is not encoded
            let finalRedirectUri = redirectUri;
            // If redirect URI already contains encoded characters, try to decode
            if (redirectUri.includes('%')) {
                try {
                    finalRedirectUri = decodeURIComponent(redirectUri);
                    this.app.getLogger().debug('Decoded redirect URI:', finalRedirectUri);
                } catch (e) {
                    this.app.getLogger().debug('Failed to decode redirect URI, using original');
                }
            }

            authUrl.searchParams.append('redirect_uri', finalRedirectUri);
            authUrl.searchParams.append('response_type', 'code');
            authUrl.searchParams.append('state', state);
            authUrl.searchParams.append('scope', 'default');
            
            this.app.getLogger().debug(`Generated authorization URL for user ${user.username} with state: ${state}`);
            return authUrl.toString();
        } catch (error) {
            this.app.getLogger().error(`Error getting authorization URL for user ${user.username}:`, error);
            
            // Ensure to return a string error message
            let errorMessage = 'Error getting authorization URL';
            
            if (error && typeof error === 'object') {
                if (error.message) {
                    errorMessage += `: ${error.message}`;
                } else {
                    try {
                        errorMessage += `: ${JSON.stringify(error)}`;
                    } catch (e) {
                        errorMessage += ': Unknown error object';
                    }
                }
            } else if (error) {
                errorMessage += `: ${error}`;
            }
            
            throw new Error(errorMessage);
        }
    }

    public async getAccessTokenForUser(user: IUser, read: IRead): Promise<any> {
        try {
            if (!this.oauthClient) {
                throw new Error('OAuth client not initialized');
            }
            
            this.app.getLogger().debug(`Attempting to get access token for user: ${user.username} (ID: ${user.id})`);
            
            // Directly get user token from persistent storage
            const association = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, user.id);
            this.app.getLogger().debug(`Looking for token with association: ${JSON.stringify(association)}`);
            
            const [tokenData] = await read.getPersistenceReader().readByAssociation(association);
            
            if (tokenData) {
                this.app.getLogger().debug(`Token retrieved for user ${user.username}:`, tokenData);
                return tokenData;
            } else {
                this.app.getLogger().debug(`No token found in persistence for user ${user.username}, trying OAuth client`);
                
                // If direct retrieval fails, try using OAuth client
                const tokenInfo = await this.oauthClient.getAccessTokenForUser(user);
                if (tokenInfo) {
                    this.app.getLogger().debug(`Token retrieved from OAuth client for user ${user.username}:`, tokenInfo);
                    return tokenInfo;
                } else {
                    this.app.getLogger().debug(`No token found from OAuth client for user ${user.username}, trying app user`);
                    
                    // If still not found, try to get token from app bot user
                    const appUser = await this.app.getAccessors().reader.getUserReader().getAppUser();
                    if (appUser) {
                        this.app.getLogger().debug(`Trying to get token from app user: ${appUser.username} (ID: ${appUser.id})`);
                        
                        const appUserAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, appUser.id);
                        const [appUserTokenData] = await read.getPersistenceReader().readByAssociation(appUserAssociation);
                        
                        if (appUserTokenData) {
                            this.app.getLogger().debug(`Token retrieved from app user ${appUser.username}:`, appUserTokenData);
                            return appUserTokenData;
                        }
                    }
                    
                    this.app.getLogger().warn(`No access token found for user: ${user.username}`);
                    return null;
                }
            }
        } catch (error) {
            this.app.getLogger().error(`Failed to get access token for user: ${user.username}`, error);
            return null;
        }
    }

    public async handleOAuthCallback(user: IUser, code: string, state: string, read: IRead, http: IHttp, persis: IPersistence): Promise<boolean> {
        try {
            if (!this.oauthClient) {
                throw new Error('OAuth client not initialized');
            }
            
            this.app.getLogger().debug(`Handling OAuth callback for user ${user.username} with code: ${code.substring(0, 5)}... and state: ${state}`);
            
            // Use the correct method to handle OAuth callback
            // Get environment settings
            const environmentReader = this.app.getAccessors().environmentReader;
            const clientId = await environmentReader.getSettings().getValueById(AppSetting.AsanaClientId);
            const clientSecret = await environmentReader.getSettings().getValueById(AppSetting.AsanaClientSecret);
            const redirectUri = await environmentReader.getSettings().getValueById(AppSetting.AsanaRedirectUri);
            
            // Check if redirect URI is correct
            if (!redirectUri) {
                this.app.getLogger().error('Redirect URI is not set');
                return false;
            }

            // Check if redirect URI contains special characters or encoding issues
            this.app.getLogger().debug('Checking redirect URI:', {
                redirectUri,
                length: redirectUri.length,
                containsEncodedChars: redirectUri.includes('%')
            });
            
            // Ensure redirect URI is not encoded
            let finalRedirectUri = redirectUri;
            // If redirect URI already contains encoded characters, try to decode
            if (redirectUri.includes('%')) {
                try {
                    finalRedirectUri = decodeURIComponent(redirectUri);
                    this.app.getLogger().debug('Decoded redirect URI:', finalRedirectUri);
                } catch (e) {
                    this.app.getLogger().debug('Failed to decode redirect URI, using original');
                }
            }

            this.app.getLogger().debug('OAuth settings retrieved:', {
                clientIdSet: !!clientId,
                clientSecretSet: !!clientSecret,
                redirectUriSet: !!redirectUri
            });
            
            // Send request to get access token
            this.app.getLogger().debug('Sending token request to Asana');
            
            try {
                // Try using different ways to build the request
                const formData = new URLSearchParams();
                formData.append('grant_type', 'authorization_code');
                formData.append('code', code);
                formData.append('client_id', clientId);
                formData.append('client_secret', clientSecret);
                formData.append('redirect_uri', finalRedirectUri);
                
                this.app.getLogger().debug('Form data:', formData.toString());
                
                const response = await http.post('https://app.asana.com/-/oauth_token', {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    content: formData.toString()
                });
                
                this.app.getLogger().debug(`Token response received with status: ${response.statusCode}`);
                
                // Log complete response content for debugging
                if (response.statusCode !== 200) {
                    try {
                        let errorData = response.content || response.data;
                        if (typeof errorData === 'string') {
                            try {
                                errorData = JSON.parse(errorData);
                            } catch (e) {
                                // 如果不是有效的JSON，保持原样
                            }
                        }
                        this.app.getLogger().error('Token request failed with error:', errorData);
                    } catch (e) {
                        this.app.getLogger().error('Error parsing error response:', e);
                    }
                }
                
                if (response.statusCode === 200 && (response.data || response.content)) {
                    const tokenData = response.data || (response.content ? JSON.parse(response.content) : {});
                    this.app.getLogger().debug(`Token data retrieved for user ${user.username}:`, tokenData);
                    
                    // Create user association
                    const association = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, user.id);
                    this.app.getLogger().debug(`Storing token with association: ${JSON.stringify(association)} for user: ${user.username} (ID: ${user.id})`);
                    
                    await persis.updateByAssociation(association, tokenData, true);
                    
                    // Try to extract actual user ID from state parameter
                    if (state && state.includes('_')) {
                        const actualUserId = state.split('_')[0];
                        if (actualUserId && actualUserId !== user.id) {
                            this.app.getLogger().debug(`Extracted actual user ID from state: ${actualUserId}`);
                            
                            // Create association and store token for actual user
                            const actualUserAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.USER, actualUserId);
                            this.app.getLogger().debug(`Also storing token with association: ${JSON.stringify(actualUserAssociation)} for actual user ID: ${actualUserId}`);
                            
                            await persis.updateByAssociation(actualUserAssociation, tokenData, true);
                            this.app.getLogger().info(`Access token also stored for actual user ID: ${actualUserId}`);
                        }
                    }
                    
                    this.app.getLogger().info(`Access token stored for user: ${user.username}`);
                    return true;
                } else {
                    this.app.getLogger().error(`Failed to get access token: ${response.statusCode} - ${response.content || response.data}`);
                    return false;
                }
            } catch (requestError) {
                this.app.getLogger().error('Error making token request:', requestError);
                return false;
            }
        } catch (error) {
            this.app.getLogger().error(`Error handling OAuth callback for user ${user.username}:`, error);
            return false;
        }
    }
}

export default AsanaOAuth2Service;
