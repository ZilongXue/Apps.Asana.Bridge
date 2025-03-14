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
import { IApiEndpointMetadata } from '@rocket.chat/apps-engine/definition/api';
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
            
            // 检查设置是否已配置
            const clientId = await environmentRead.getSettings().getValueById('asana_client_id');
            const clientSecret = await environmentRead.getSettings().getValueById('asana_client_secret');
            const redirectUri = await environmentRead.getSettings().getValueById('asana_redirect_uri');
            
            this.getLogger().debug('Asana settings on initialize:', {
                clientIdSet: !!clientId,
                clientSecretSet: !!clientSecret,
                redirectUriSet: !!redirectUri
            });
            
            this.getLogger().debug('Asana Integration App initialized');
        } catch (error) {
            this.getLogger().error('Error initializing Asana Integration App:', error);
        }
    }

    protected async extendConfiguration(configuration: IConfigurationExtend, environmentRead: IEnvironmentRead): Promise<void> {
        // 注册设置
        await Promise.all(settings.map((setting) => configuration.settings.provideSetting(setting)));
        
        // 注册命令
        await configuration.slashCommands.provideSlashCommand(new AsanaCommand(this));
        
        // 注册 API 端点
        await configuration.api.provideApi({
            visibility: ApiVisibility.PUBLIC,
            security: ApiSecurity.UNSECURE,
            endpoints: [
                new AsanaOAuthEndpoint(this),
                new AsanaWebhookEndpoint(this),
            ],
        });
        
        // 设置 OAuth2 服务
        await this.oauth2Service.setup(configuration);
    }

    public async onSettingUpdated(setting: any, configurationModify: any, read: any, http: any): Promise<void> {
        this.getLogger().debug(`Setting updated: ${setting.id}`);
        
        // 当Asana相关设置更新时，重新初始化OAuth2服务
        const asanaSettings = ['asana_client_id', 'asana_client_secret', 'asana_redirect_uri'];
        if (asanaSettings.includes(setting.id)) {
            this.getLogger().debug('Asana API settings updated, reinitializing OAuth2 service');
            await this.oauth2Service.setup(configurationModify.getConfigurationExtender());
        }
    }

    public async onEnable(environmentRead: IEnvironmentRead, configurationModify: any): Promise<boolean> {
        this.getLogger().debug('Asana Integration App enabled');
        
        // 在应用启用时初始化OAuth2服务
        try {
            // 检查设置是否已配置
            const clientId = await environmentRead.getSettings().getValueById('asana_client_id');
            const clientSecret = await environmentRead.getSettings().getValueById('asana_client_secret');
            const redirectUri = await environmentRead.getSettings().getValueById('asana_redirect_uri');
            
            this.getLogger().debug('Asana settings on enable:', {
                clientIdSet: !!clientId,
                clientSecretSet: !!clientSecret,
                redirectUriSet: !!redirectUri
            });
            
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
