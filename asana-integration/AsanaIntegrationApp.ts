import {
    IAppAccessors,
    IConfigurationExtend,
    IEnvironmentRead,
    IHttp,
    ILogger,
    IModify,
    IPersistence,
    IRead,
} from '@rocket.chat/apps-engine/definition/accessors';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { ApiVisibility, ApiSecurity } from '@rocket.chat/apps-engine/definition/api';
import { settings } from './settings/Settings';
import AsanaOAuth2Service from './lib/AsanaOAuth2Service';
import AsanaApiService from './lib/AsanaApiService';
import { AsanaCommand } from './commands/AsanaCommand';
import { AsanaOAuthEndpoint } from './endpoints/AsanaOAuthEndpoint';
import { AsanaWebhookEndpoint } from './endpoints/AsanaWebhookEndpoint';

export class AsanaIntegrationApp extends App {
    private oauth2Service: AsanaOAuth2Service;
    private apiService: AsanaApiService;

    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
        
        this.oauth2Service = new AsanaOAuth2Service(this);
        this.apiService = new AsanaApiService(this);
    }

    public async initialize(configurationExtend: IConfigurationExtend, environmentRead: IEnvironmentRead): Promise<void> {
        try {
            await this.extendConfiguration(configurationExtend, environmentRead);
            
            // check settings
            const clientId = await environmentRead.getSettings().getValueById('asana_client_id');
            const clientSecret = await environmentRead.getSettings().getValueById('asana_client_secret');
            const redirectUri = await environmentRead.getSettings().getValueById('asana_redirect_uri');

            this.getLogger().debug('Asana Integration App initialized');
        } catch (error) {
            this.getLogger().error('Error initializing Asana Integration App:', error);
        }
    }

    protected async extendConfiguration(configuration: IConfigurationExtend, environmentRead: IEnvironmentRead): Promise<void> {
        // register settings
        await Promise.all(settings.map((setting) => configuration.settings.provideSetting(setting)));
        
        // register commands
        await configuration.slashCommands.provideSlashCommand(new AsanaCommand(this));
        
        // register API endpoints
        await configuration.api.provideApi({
            visibility: ApiVisibility.PUBLIC,
            security: ApiSecurity.UNSECURE,
            endpoints: [
                new AsanaOAuthEndpoint(this),
                new AsanaWebhookEndpoint(this),
            ],
        });
        
        // setup OAuth2 service
        await this.oauth2Service.setup(configuration);
    }

    public async onSettingUpdated(setting: any, configurationModify: any, read: any, http: any): Promise<void> {
        this.getLogger().debug(`Setting updated: ${setting.id}`);
        
        // when Asana related settings are updated, reinitialize OAuth2 service
        const asanaSettings = ['asana_client_id', 'asana_client_secret', 'asana_redirect_uri'];
        if (asanaSettings.includes(setting.id)) {
            this.getLogger().debug('Asana API settings updated, reinitializing OAuth2 service');
            await this.oauth2Service.setup(configurationModify.getConfigurationExtender());
        }
    }

    public async onEnable(environmentRead: IEnvironmentRead, configurationModify: any): Promise<boolean> {
        this.getLogger().debug('Asana Integration App enabled');
        
        try {
            // check settings
            const clientId = await environmentRead.getSettings().getValueById('asana_client_id');
            const clientSecret = await environmentRead.getSettings().getValueById('asana_client_secret');
            const redirectUri = await environmentRead.getSettings().getValueById('asana_redirect_uri');
            
            if (!clientId || !clientSecret || !redirectUri) {
                this.getLogger().warn('Asana settings not configured. OAuth2 service will not be initialized until settings are configured.');
                return true;
            }
            
            await this.oauth2Service.setup(configurationModify.getConfigurationExtender());
            this.getLogger().debug('OAuth2 service initialized on app enable');
            return true;
        } catch (error) {
            this.getLogger().error('Failed to initialize OAuth2 service on app enable:', error);
            return true; // 仍然返回true以允许应用启用
        }
    }

    public async onDisable(configurationModify: any): Promise<void> {
        this.getLogger().debug('Asana Integration App disabled');
    }

    public getOAuth2Service(): AsanaOAuth2Service {
        return this.oauth2Service;
    }

    public getApiService(): AsanaApiService {
        return this.apiService;
    }
}
