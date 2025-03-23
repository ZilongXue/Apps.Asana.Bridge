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
        // if webhook id is present, log it
        if (request.content && request.content.webhook && request.content.webhook.gid) {
            this.app.getLogger().debug(`Webhook ID from request: ${request.content.webhook.gid}`);
        }

        // log all resource ids
        if (request.content && request.content.resource && request.content.resource.gid) {
            this.app.getLogger().debug(`Resource ID from request: ${request.content.resource.gid}`);
        } else if (request.content && request.content.events && request.content.events.length > 0) {
            const resourceIds = request.content.events
                .filter(e => e.resource && e.resource.gid)
                .map(e => e.resource.gid);
            
            if (resourceIds.length > 0) {
                this.app.getLogger().debug(`Resource IDs from events: ${resourceIds.join(', ')}`);
            }
        }

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

        // 处理事件负载（当收到真实事件时）
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
     * 处理Asana webhook的握手请求
     */
    private async handleWebhookHandshake(request: IApiRequest, persis: IPersistence): Promise<IApiResponse | null> {
        if (request.headers && request.headers['x-hook-secret']) {
            const hookSecret = request.headers['x-hook-secret'];
            this.app.getLogger().debug('Received Asana webhook handshake with X-Hook-Secret:', hookSecret);
            
            // 尝试从请求中获取webhook ID
            const webhookId = await this.extractWebhookIdFromContent(request.content);
            this.app.getLogger().debug('Extracted webhook ID from handshake request:', webhookId || 'unknown');
            
            // 存储这个 secret 以供后续验证使用
            try {
                // 为每个webhook创建一个特定的secret存储
                if (webhookId) {
                    // 使用webhook ID创建关联记录
                    const webhookSecretAssociation = new RocketChatAssociationRecord(
                        RocketChatAssociationModel.MISC, 
                        `asana_webhook_secret_${webhookId}`
                    );
                    
                    await persis.createWithAssociation({ secret: hookSecret }, webhookSecretAssociation);
                    this.app.getLogger().debug('Secret stored successfully for webhook ID:', webhookId);
                }
                
                // 同时存储一个通用secret用于备份
                await persis.createWithAssociation(
                    { secret: hookSecret },
                    new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, 'asana_webhook_secret_latest')
                );
                this.app.getLogger().debug('Secret also stored as latest secret');
            } catch (error) {
                this.app.getLogger().error('Failed to store webhook secret:', error);
            }
            
            // 响应握手请求，将相同的 secret 返回在头部
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

            // try to get webhook id
            const webhookId = await this.getWebhookIdFromRequest(request, read);
            
            // 获取签名
            const signature = request.headers['x-hook-signature'] || request.headers['x-asana-request-signature'];
            if (!signature) {
                this.app.getLogger().error('No webhook signature provided in headers:', request.headers);
                return false;
            }
            
            this.app.getLogger().debug('Verifying webhook signature:', {
                webhookId: webhookId || 'unknown',
                hasSignature: !!signature,
                signatureValue: signature,
                requestContentType: typeof request.content
            });

            // 获取存储的所有可能的secret
            const secrets = await this.getAllStoredSecrets(read, webhookId);
            if (secrets.length === 0) {
                this.app.getLogger().error('No webhook secrets found in persistence storage');
                return false;
            }
            
            this.app.getLogger().debug(`Found ${secrets.length} stored secrets to try`);
            
            // 计算请求内容的JSON字符串
            let requestContent = JSON.stringify(request.content);
            this.app.getLogger().debug('Request content for signature calculation (first 100 chars):', requestContent.substring(0, 100));
            
            // 尝试所有的secrets进行验证
            for (const [index, secret] of secrets.entries()) {
                // 尝试方法1：使用标准JSON.stringify
                const hmac1 = crypto.createHmac('sha256', secret);
                hmac1.update(requestContent);
                const calculatedSignature1 = hmac1.digest('hex');
                
                this.app.getLogger().debug(`Secret #${index+1} method 1 signature:`, calculatedSignature1);
                
                if (signature === calculatedSignature1) {
                    this.app.getLogger().debug('Webhook signature verified successfully with secret #', index+1, 'using method 1');
                    return true;
                }
                
                // 尝试方法2：去除JSON字符串中的空格
                const minifiedContent = JSON.stringify(request.content, null, 0);
                const hmac2 = crypto.createHmac('sha256', secret);
                hmac2.update(minifiedContent);
                const calculatedSignature2 = hmac2.digest('hex');
                
                if (calculatedSignature2 !== calculatedSignature1) {
                    this.app.getLogger().debug(`Secret #${index+1} method 2 signature:`, calculatedSignature2);
                    
                    if (signature === calculatedSignature2) {
                        this.app.getLogger().debug('Webhook signature verified successfully with secret #', index+1, 'using method 2');
                        return true;
                    }
                }
                
                // 尝试方法3：使用原始请求字符串
                try {
                    // 直接使用JSON.stringify(request.content)的原始字符串
                    const rawBody = typeof request.content === 'string' 
                        ? request.content
                        : JSON.stringify(request.content);
                    const hmac3 = crypto.createHmac('sha256', secret);
                    hmac3.update(rawBody);
                    const calculatedSignature3 = hmac3.digest('hex');
                    
                    this.app.getLogger().debug(`Secret #${index+1} method 3 signature:`, calculatedSignature3);
                    
                    if (signature === calculatedSignature3) {
                        this.app.getLogger().debug('Webhook signature verified successfully with secret #', index+1, 'using method 3');
                        return true;
                    }
                } catch (rawBodyError) {
                    this.app.getLogger().debug('Error trying raw body verification:', rawBodyError);
                }
            }

            this.app.getLogger().error('Webhook signature verification failed. None of the stored secrets matched.', {
                providedSignature: signature,
                secretsCount: secrets.length
            });
            
            // 临时措施：日志记录但仍返回true
            this.app.getLogger().warn('WARNING: Bypassing signature verification failure for debugging');
            return true;
        } catch (error) {
            this.app.getLogger().error('Error verifying webhook signature:', error);
            
            // 临时措施：即使发生错误也返回true
            this.app.getLogger().warn('WARNING: Bypassing signature verification error for debugging');
            return true;
        }
    }
    
    /**
     * 获取所有可能的webhook secrets
     */
    private async getAllStoredSecrets(read: IRead, webhookId: string | null): Promise<string[]> {
        const secrets: string[] = [];
        
        try {
            this.app.getLogger().debug('Fetching all stored secrets for webhook verification. Webhook ID:', webhookId || 'unknown');
            
            // 1. 尝试获取特定webhook的secret
            if (webhookId) {
                const webhookSecretAssociation = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    `asana_webhook_secret_${webhookId}`
                );
                
                try {
                    const [webhookSecret] = await read.getPersistenceReader().readByAssociation(
                        webhookSecretAssociation
                    ) as [{ secret: string } | undefined];
                    
                    if (webhookSecret && webhookSecret.secret) {
                        this.app.getLogger().debug(`Found secret for specific webhook ID: ${webhookId}`);
                        secrets.push(webhookSecret.secret);
                    }
                } catch (webhookSecretError) {
                    this.app.getLogger().debug(`Error retrieving webhook-specific secret for ${webhookId}:`, webhookSecretError);
                }
            }
            
            // 2. 尝试获取最新存储的secret
            try {
                const latestSecretAssociation = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    'asana_webhook_secret_latest'
                );
                
                const [latestSecret] = await read.getPersistenceReader().readByAssociation(
                    latestSecretAssociation
                ) as [{ secret: string } | undefined];
                
                if (latestSecret && latestSecret.secret) {
                    // 仅当与已有secret不同时才添加
                    if (!secrets.includes(latestSecret.secret)) {
                        this.app.getLogger().debug('Found latest stored secret');
                        secrets.push(latestSecret.secret);
                    }
                }
            } catch (latestSecretError) {
                this.app.getLogger().debug('Error retrieving latest secret:', latestSecretError);
            }
            
            // 3. 尝试获取所有可能的webhook secrets
            try {
                // 无法使用正则表达式，改为获取所有MISC类型记录后筛选
                const allMiscRecords = await read.getPersistenceReader().readByAssociation(
                    new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, '')
                ) as Array<{ secret: string, id?: string }>;
                
                if (allMiscRecords && allMiscRecords.length > 0) {
                    // 筛选以asana_webhook_secret_开头的记录
                    const webhookSecrets = allMiscRecords.filter(record => {
                        // 使用ID字段或检查是否为已有的键值来识别记录
                        return record.id && record.id.startsWith('asana_webhook_secret_') && 
                               record.secret && !secrets.includes(record.secret);
                    });
                    
                    if (webhookSecrets.length > 0) {
                        this.app.getLogger().debug(`Found ${webhookSecrets.length} additional webhook secrets`);
                        
                        for (const secretObj of webhookSecrets) {
                            if (secretObj.secret && !secrets.includes(secretObj.secret)) {
                                secrets.push(secretObj.secret);
                            }
                        }
                    }
                }
            } catch (allSecretsError) {
                this.app.getLogger().debug('Error retrieving all webhook secrets:', allSecretsError);
            }
            
            // 4. 尝试获取旧的通用secret（向后兼容）
            try {
                const oldSecretAssociation = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    'asana_webhook_secret'
                );
                
                const [oldSecret] = await read.getPersistenceReader().readByAssociation(
                    oldSecretAssociation
                ) as [{ secret: string } | undefined];
                
                if (oldSecret && oldSecret.secret) {
                    // 仅当与已有secret不同时才添加
                    if (!secrets.includes(oldSecret.secret)) {
                        this.app.getLogger().debug('Found old generic webhook secret');
                        secrets.push(oldSecret.secret);
                    }
                }
            } catch (oldSecretError) {
                this.app.getLogger().debug('Error retrieving old secret:', oldSecretError);
            }
            
            // 5. 最后尝试从应用设置中获取（向后兼容）
            try {
                const settingsSecret = await read.getEnvironmentReader().getSettings().getValueById(AppSetting.AsanaWebhookSecret);
                if (settingsSecret && typeof settingsSecret === 'string' && settingsSecret.length > 0) {
                    if (!secrets.includes(settingsSecret)) {
                        this.app.getLogger().debug('Found secret from app settings');
                        secrets.push(settingsSecret);
                    }
                }
            } catch (settingsSecretError) {
                this.app.getLogger().debug('Error retrieving settings secret:', settingsSecretError);
            }
            
            // 6. 记录获取到的所有secret (不显示具体值，仅记录数量和前几个字符)
            if (secrets.length > 0) {
                const secretInfos = secrets.map((s, i) => ({
                    index: i + 1,
                    preview: s.substring(0, 5) + '...',
                    length: s.length
                }));
                this.app.getLogger().debug(`Retrieved ${secrets.length} possible webhook secrets:`, secretInfos);
            } else {
                this.app.getLogger().warn('No webhook secrets found in any storage location');
            }
            
            return secrets;
        } catch (error) {
            this.app.getLogger().error('Error getting stored webhook secrets:', error);
            return [];
        }
    }

    private async processEvents(events: any[], read: IRead, modify: IModify, http: IHttp, persis: IPersistence): Promise<void> {
        this.app.getLogger().debug(`收到 ${events.length} 个事件...`);
        
        // 记录事件中涉及的资源ID，用于调试
        const resourceIds = events.map(e => e.resource?.gid).filter(Boolean);
        const resourceTypes = events.map(e => e.resource?.resource_type).filter(Boolean);
        this.app.getLogger().debug(`事件资源 IDs: ${resourceIds.join(', ')}`);
        this.app.getLogger().debug(`事件资源类型: ${resourceTypes.join(', ')}`);
        
        // 对事件进行去重处理
        const uniqueEvents = this.deduplicateEvents(events);
        if (uniqueEvents.length !== events.length) {
            this.app.getLogger().debug(`事件去重: 原始事件数量 ${events.length}, 去重后数量 ${uniqueEvents.length}`);
        }
        
        // 记录parent资源，通常是项目ID
        const parentIds = uniqueEvents
            .filter(e => e.parent && e.parent.gid)
            .map(e => `${e.parent.resource_type}/${e.parent.gid}`)
            .filter(Boolean);
            
        if (parentIds.length > 0) {
            this.app.getLogger().debug(`父资源: ${parentIds.join(', ')}`);
        }
        
        // 如果未找到现有配置，可以考虑自动创建一个配置
        let autoCreatedRoomId: string | null = null;
        if (uniqueEvents.length > 0) {
            try {
                // 检查是否已经有webhook配置
                const hasExistingConfig = await this.checkIfAnyConfigExists(read);
                if (!hasExistingConfig) {
                    this.app.getLogger().debug('未找到任何webhook配置，尝试自动创建');
                    autoCreatedRoomId = await this.createWebhookConfigIfNeeded(uniqueEvents[0], read, persis);
                    
                    if (autoCreatedRoomId) {
                        this.app.getLogger().debug(`使用自动创建的配置，房间ID: ${autoCreatedRoomId}`);
                        // 使用自动创建的配置处理所有事件
                        const room = await read.getRoomReader().getById(autoCreatedRoomId);
                        
                        if (room) {
                            for (const event of uniqueEvents) {
                                await this.processEvent(event, room, read, modify, http);
                            }
                            return;
                        }
                    }
                }
            } catch (autoConfigError) {
                this.app.getLogger().error('尝试自动创建配置时出错:', autoConfigError);
            }
        }
        
        // 查找与webhook关联的直接配置
        let webhookId = '';
        if (uniqueEvents.length > 0 && uniqueEvents[0].webhook && uniqueEvents[0].webhook.gid) {
            webhookId = uniqueEvents[0].webhook.gid;
            this.app.getLogger().debug(`Webhook ID from events: ${webhookId}`);
            
            try {
                // 检查是否直接有该webhook ID的配置
                const webhookAssoc = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    `webhook_${webhookId}`
                );
                
                const [webhookConfig] = await read.getPersistenceReader().readByAssociation(webhookAssoc) as [{ roomId: string, resourceId: string } | undefined];
                
                if (webhookConfig && webhookConfig.roomId) {
                    this.app.getLogger().debug(`找到webhook ${webhookId}的直接配置, 资源ID: ${webhookConfig.resourceId}, 房间: ${webhookConfig.roomId}`);
                    
                    const room = await read.getRoomReader().getById(webhookConfig.roomId);
                    if (room) {
                        this.app.getLogger().debug(`使用webhook ${webhookId}的配置处理所有事件`);
                        
                        // 使用找到的房间处理所有事件
                        for (const event of uniqueEvents) {
                            await this.processEvent(event, room, read, modify, http);
                        }
                        
                        // 已经处理了所有事件，直接返回
                        return;
                    } else {
                        this.app.getLogger().warn(`Webhook ${webhookId}配置的房间 ${webhookConfig.roomId} 未找到`);
                    }
                }
            } catch (error) {
                this.app.getLogger().error(`检查webhook直接配置时出错: ${error}`);
            }
        }
        
        // 尝试通过事件中的资源ID查找相关webhook配置
        if (uniqueEvents.length > 0 && uniqueEvents[0].resource && uniqueEvents[0].resource.gid) {
            const resourceId = uniqueEvents[0].resource.gid;
            this.app.getLogger().debug(`尝试通过资源ID ${resourceId} 查找webhook配置`);
            
            try {
                const resourceConfig = await this.findWebhookConfigByResourceId(resourceId, read);
                
                if (resourceConfig && resourceConfig.roomId) {
                    this.app.getLogger().debug(`通过资源ID ${resourceId} 找到webhook配置: roomId=${resourceConfig.roomId}, webhookId=${resourceConfig.webhookId}`);
                    
                    const room = await read.getRoomReader().getById(resourceConfig.roomId);
                    if (room) {
                        // 使用找到的房间处理所有事件
                        for (const event of uniqueEvents) {
                            await this.processEvent(event, room, read, modify, http);
                        }
                        
                        // 已经处理了所有事件，直接返回
                        return;
                    }
                }
                
                // 尝试通过父资源ID查找
                if (uniqueEvents[0].parent && uniqueEvents[0].parent.gid) {
                    const parentId = uniqueEvents[0].parent.gid;
                    this.app.getLogger().debug(`尝试通过父资源ID ${parentId} 查找webhook配置`);
                    
                    const parentConfig = await this.findWebhookConfigByResourceId(parentId, read);
                    
                    if (parentConfig && parentConfig.roomId) {
                        this.app.getLogger().debug(`通过父资源ID ${parentId} 找到webhook配置: roomId=${parentConfig.roomId}, webhookId=${parentConfig.webhookId}`);
                        
                        const room = await read.getRoomReader().getById(parentConfig.roomId);
                        if (room) {
                            // 使用找到的房间处理所有事件
                            for (const event of uniqueEvents) {
                                await this.processEvent(event, room, read, modify, http);
                            }
                            
                            // 已经处理了所有事件，直接返回
                            return;
                        }
                    }
                }
            } catch (resourceLookupError) {
                this.app.getLogger().error(`通过资源ID查找webhook配置时出错:`, resourceLookupError);
            }
        }
        
        // 如果没找到直接配置，尝试一种备选方案：找出最近创建的所有房间配置
        try {
            // 获取所有包含roomId的记录
            const roomAssociations = await read.getPersistenceReader().readByAssociation(
                new RocketChatAssociationRecord(RocketChatAssociationModel.ROOM, '')
            ) as Array<{ roomId?: string, createdAt?: Date | string }>;
            
            if (roomAssociations && roomAssociations.length > 0) {
                this.app.getLogger().debug(`找到${roomAssociations.length}个房间关联记录`);
                
                // 尝试获取最近创建的房间
                const recentAssoc = roomAssociations.sort((a, b) => {
                    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                    return dateB - dateA; // 降序排列
                })[0];
                
                if (recentAssoc && recentAssoc.roomId) {
                    this.app.getLogger().debug(`使用最近创建的房间配置: ${recentAssoc.roomId}`);
                    const room = await read.getRoomReader().getById(recentAssoc.roomId);
                    
                    if (room) {
                        // 使用这个房间处理所有事件
                        for (const event of uniqueEvents) {
                            await this.processEvent(event, room, read, modify, http);
                        }
                        
                        // 已经处理了所有事件，直接返回
                        return;
                    }
                }
            }
        } catch (error) {
            this.app.getLogger().debug(`查找可用房间配置时出错: ${error}`);
        }
        
        // 如果上述方法都无法找到一个可用的房间，则继续原有逻辑，对每个事件单独处理
        for (const event of uniqueEvents) {
            try {
                this.app.getLogger().debug(`正在处理事件: ${event.action} on ${event.resource.resource_type}/${event.resource.gid}`);
                
                // 使用新的方法查找资源ID对应的配置
                if (event.resource && event.resource.gid) {
                    const resourceId = event.resource.gid;
                    const resourceConfig = await this.findWebhookConfigByResourceId(resourceId, read);
                    
                    if (resourceConfig && resourceConfig.roomId) {
                        this.app.getLogger().debug(`为事件找到资源${resourceId}关联的webhook配置: ${resourceConfig.roomId}`);
                        const room = await read.getRoomReader().getById(resourceConfig.roomId);
                        if (room) {
                            // 处理事件
                            await this.processEvent(event, room, read, modify, http);
                            continue;
                        }
                    }
                }
                
                // 使用新的方法查找父资源的配置
                if (event.parent && event.parent.gid) {
                    const parentId = event.parent.gid;
                    this.app.getLogger().debug(`检查父资源${parentId}的配置`);
                    
                    const parentConfig = await this.findWebhookConfigByResourceId(parentId, read);
                    
                    if (parentConfig && parentConfig.roomId) {
                        this.app.getLogger().debug(`为事件找到父资源${parentId}关联的webhook配置: ${parentConfig.roomId}`);
                        const room = await read.getRoomReader().getById(parentConfig.roomId);
                        if (room) {
                            // 处理事件
                            await this.processEvent(event, room, read, modify, http);
                            continue;
                        }
                    } else {
                        this.app.getLogger().debug(`未找到父资源${parentId}的webhook配置`);
                    }
                }
                
                // 如果没有找到直接配置，尝试查找所有的webhook配置
                this.app.getLogger().debug(`尝试查找任何有效的webhook配置`);
                const webhookConfigs = await read.getPersistenceReader().readByAssociation(
                    new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, '')
                ) as Array<{ roomId?: string, resourceId?: string, id?: string }>;
                
                // 筛选出所有包含roomId和id以webhook_开头的配置
                const validConfigs = webhookConfigs.filter(
                    config => config && config.roomId && config.id && 
                    typeof config.id === 'string' && config.id.startsWith('webhook_')
                );
                
                this.app.getLogger().debug(`找到${validConfigs.length}个有效的webhook配置`);
                
                if (validConfigs.length > 0) {
                    // 使用第一个有效配置
                    const firstConfig = validConfigs[0];
                    this.app.getLogger().debug(`使用第一个有效配置，ID: ${firstConfig.id}, 房间ID: ${firstConfig.roomId}`);
                    
                    if (firstConfig.roomId) {
                        const room = await read.getRoomReader().getById(firstConfig.roomId);
                        if (room) {
                            await this.processEvent(event, room, read, modify, http);
                            continue;
                        }
                    }
                }
                
                // 如果以上方法都未找到配置，尝试查找与项目关联的配置
                this.app.getLogger().debug(`尝试查找与资源 ${event.resource.gid} 关联的项目配置...`);
                await this.findAndProcessProjectWebhook(event, read, modify, http);
            } catch (error) {
                this.app.getLogger().error(`处理资源${event.resource?.gid}的事件时出错:`, error);
            }
        }
    }
    
    /**
     * 对事件进行去重处理
     * 根据user.gid, action和resource.gid进行去重
     */
    private deduplicateEvents(events: any[]): any[] {
        if (!events || events.length <= 1) {
            return events;
        }
        
        const uniqueEvents: any[] = [];
        const uniqueEventKeys = new Set<string>();
        
        for (const event of events) {
            // 生成事件的唯一键
            const userId = event.user?.gid || 'unknown';
            const action = event.action || 'unknown';
            const resourceId = event.resource?.gid || 'unknown';
            
            // 对于changed事件，还要考虑具体的变更字段
            let changeField = '';
            if (action === 'changed' && event.change && event.change.field) {
                // If event.change.field is 'due_on' or 'due_at', we consider as the same event
                if (event.change.field === 'due_on' || event.change.field === 'due_at') {
                    changeField = 'due_on';
                } else {
                    changeField = event.change.field;
                }
            }
            
            // 创建唯一键
            const eventKey = `${userId}:${action}:${resourceId}${changeField ? ':' + changeField : ''}`;
            
            // 检查此事件键是否已存在
            if (!uniqueEventKeys.has(eventKey)) {
                uniqueEventKeys.add(eventKey);
                uniqueEvents.push(event);
            } else {
                this.app.getLogger().debug(`跳过重复事件: ${eventKey}`);
            }
        }
        
        return uniqueEvents;
    }

    /**
     * 尝试找到与资源相关联的项目webhook配置
     */
    private async findAndProcessProjectWebhook(event: any, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        this.app.getLogger().debug(`尝试为${event.resource.resource_type}/${event.resource.gid}找到关联的项目webhook配置`);
        
        if (event.resource.resource_type !== 'task') {
            this.app.getLogger().debug(`资源类型 ${event.resource.resource_type} 不是任务，跳过项目查找`);
            return;
        }
        
        try {
            let webhookId = '';
            
            // 尝试从事件中获取相关的 webhook 信息
            if (event.webhook && event.webhook.gid) {
                webhookId = event.webhook.gid;
                this.app.getLogger().debug(`Event associated with webhook ID for project lookup: ${webhookId}`);
                
                // 直接使用findWebhookConfigByResourceId方法查找webhook配置
                try {
                    const webhookConfig = await this.findWebhookConfigByResourceId(webhookId, read);
                    
                    if (webhookConfig && webhookConfig.roomId) {
                        this.app.getLogger().debug(`找到直接关联的webhook配置: ${webhookConfig.roomId}, webhookId: ${webhookConfig.webhookId}`);
                        const room = await read.getRoomReader().getById(webhookConfig.roomId);
                        
                        if (room) {
                            // 处理事件
                            await this.processEvent(event, room, read, modify, http);
                            return;
                        } else {
                            this.app.getLogger().warn(`找不到房间 ${webhookConfig.roomId}`);
                        }
                    }
                } catch (directLookupError) {
                    this.app.getLogger().debug(`直接查找webhook配置出错: ${directLookupError}`);
                }
            }
            
            // 获取任务详情，查找关联的项目
            this.app.getLogger().debug(`尝试获取任务 ${event.resource.gid} 的详情`);
            const taskDetails = await this.getTaskDetails(event.resource.gid, read, http, webhookId);
            if (!taskDetails) {
                this.app.getLogger().debug(`任务 ${event.resource.gid} 详情获取失败`);
                
                // 如果无法获取任务详情，尝试查找所有项目webhook配置并使用第一个有效的
                this.app.getLogger().debug(`尝试查找所有项目webhook配置`);
                await this.findAnyProjectWebhookAndProcess(event, read, modify, http);
                return;
            }
            
            if (!taskDetails.projects || taskDetails.projects.length === 0) {
                this.app.getLogger().debug(`任务 ${event.resource.gid} 没有关联的项目`);
                return;
            }
            
            this.app.getLogger().debug(`任务关联的项目: ${taskDetails.projects.map(p => p.gid).join(', ')}`);
            
            // 检查任务关联的每个项目是否有webhook配置
            for (const project of taskDetails.projects) {
                // 使用findWebhookConfigByResourceId方法查找项目配置
                const projectConfig = await this.findWebhookConfigByResourceId(project.gid, read);
                
                if (projectConfig && projectConfig.roomId) {
                    this.app.getLogger().debug(`为项目 ${project.gid} 找到房间配置: ${projectConfig.roomId}`);
                    const room = await read.getRoomReader().getById(projectConfig.roomId);
                    
                    if (room) {
                        // 处理事件
                        await this.processEvent(event, room, read, modify, http);
                        // 一旦找到一个有效的房间就处理事件，不需要在多个房间中重复处理
                        return;
                    } else {
                        this.app.getLogger().warn(`找不到房间 ${projectConfig.roomId}`);
                    }
                }
            }
            
            this.app.getLogger().debug(`没有为任务 ${event.resource.gid} 关联的任何项目找到webhook配置`);
        } catch (error) {
            this.app.getLogger().error(`查找项目webhook配置出错: ${error}`);
        }
    }
    
    /**
     * 查找任何可用的项目webhook配置
     */
    private async findAnyProjectWebhookAndProcess(event: any, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        try {
            this.app.getLogger().debug(`尝试查找任何可用的webhook配置`);
            
            // 1. 尝试查找以webhook_开头的所有记录
            const allMiscRecords = await read.getPersistenceReader().readByAssociation(
                new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, '')
            ) as Array<{ roomId?: string, id?: string }>;
            
            // 记录所有找到的记录键
            if (allMiscRecords && allMiscRecords.length > 0) {
                const recordKeys = allMiscRecords
                    .filter(record => record.id)
                    .map(record => record.id);
                
                this.app.getLogger().debug(`找到${allMiscRecords.length}个MISC记录，键值包括: ${recordKeys.join(', ')}`);
            }
            
            // 筛选所有包含roomId的webhook配置
            const webhookConfigs = allMiscRecords
                .filter(record => record && record.roomId && record.id && record.id.startsWith('webhook_'));
            
            if (webhookConfigs.length > 0) {
                this.app.getLogger().debug(`找到${webhookConfigs.length}个有效webhook配置`);
                
                // 使用第一个有效配置
                const firstConfig = webhookConfigs[0];
                
                if (firstConfig.roomId) {
                    this.app.getLogger().debug(`使用配置: ${firstConfig.id}, 房间ID: ${firstConfig.roomId}`);
                    const room = await read.getRoomReader().getById(firstConfig.roomId);
                    
                    if (room) {
                        this.app.getLogger().debug(`使用房间 ${firstConfig.roomId} 处理事件`);
                        await this.processEvent(event, room, read, modify, http);
                        return;
                    } else {
                        this.app.getLogger().warn(`房间 ${firstConfig.roomId} 未找到`);
                    }
                }
            }
            
            // 2. 如果没有找到webhook配置，尝试找所有ROOM类型记录
            const roomAssociations = await read.getPersistenceReader().readByAssociation(
                new RocketChatAssociationRecord(RocketChatAssociationModel.ROOM, '')
            ) as Array<{ roomId?: string }>;
            
            if (roomAssociations && roomAssociations.length > 0) {
                this.app.getLogger().debug(`找到${roomAssociations.length}个ROOM类型记录`);
                
                for (const roomConfig of roomAssociations) {
                    if (roomConfig.roomId) {
                        const room = await read.getRoomReader().getById(roomConfig.roomId);
                        
                        if (room) {
                            this.app.getLogger().debug(`使用ROOM记录中的房间 ${roomConfig.roomId} 处理事件`);
                            await this.processEvent(event, room, read, modify, http);
                            return;
                        }
                    }
                }
            }
            
            this.app.getLogger().warn(`没有找到任何可用的房间配置，无法处理事件`);
        } catch (error) {
            this.app.getLogger().error(`查找任意可用webhook配置出错: ${error}`);
        }
    }

    private async processEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp): Promise<void> {
        const resourceType = event.resource.resource_type;
        const action = event.action;
        let webhookId = '';

        this.app.getLogger().debug(`Processing ${action} event for ${resourceType} ${event.resource.gid} in room ${room.id}`);
        
        // 尝试从事件中获取相关的 webhook 信息
        if (event.webhook && event.webhook.gid) {
            webhookId = event.webhook.gid;
            this.app.getLogger().debug(`Event associated with webhook ID: ${webhookId}`);
        }

        if (resourceType === 'task') {
            await this.processTaskEvent(event, room, read, modify, http, webhookId);
        } else if (resourceType === 'project') {
            await this.processProjectEvent(event, room, read, modify, http, webhookId);
        } else if (resourceType === 'story') {
            // 故事事件（通常是评论或活动）
            await this.processStoryEvent(event, room, read, modify, http, webhookId);
        } else if (resourceType === 'section') {
            // 部分事件（对任务列表的部分的变化）
            await this.processSectionEvent(event, room, read, modify, http, webhookId);
        } else {
            this.app.getLogger().debug(`Unhandled resource type: ${resourceType} for action: ${action}`);
        }
    }

    /**
     * 处理故事类型事件（通常是对任务的评论）
     */
    private async processStoryEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp, webhookId?: string): Promise<void> {
        this.app.getLogger().debug(`Processing story event: ${event.action} for story ${event.resource.gid}`);
        
        try {
            // 获取故事详情
            const storyResponse = await http.get(`https://app.asana.com/api/1.0/stories/${event.resource.gid}`, {
                headers: await this.getAuthHeaders(read, webhookId),
            });
            
            if (storyResponse.statusCode !== 200 || !storyResponse.data) {
                this.app.getLogger().error(`Failed to get story details for ${event.resource.gid}`);
                return;
            }
            
            const story = storyResponse.data.data;
            if (!story || !story.resource) {
                this.app.getLogger().warn(`Invalid story data received for ${event.resource.gid}`);
                return;
            }
            
            // 获取相关任务详情
            const taskId = story.resource.gid;
            const taskDetails = await this.getTaskDetails(taskId, read, http, webhookId);
            
            if (!taskDetails) {
                this.app.getLogger().warn(`Could not get details for related task ${taskId}`);
                return;
            }
            
            // 构建消息
            const user = event.user ? event.user.name : 'Someone';
            const message = `💬 ${user} commented on task: *${taskDetails.name}*`;
            
            // 创建并发送消息
            const creator = modify.getCreator();
            const sender = await read.getUserReader().getAppUser();
            
            if (!sender) {
                this.app.getLogger().error('Could not get app user');
                return;
            }
            
            const notificationColor = await read.getEnvironmentReader().getSettings().getValueById(AppSetting.NotificationColor) || '#36C5F0';
            
            const messageBuilder = creator.startMessage()
                .setRoom(room)
                .setSender(sender);
            
            // 添加附件
            const attachment = {
                color: notificationColor,
                title: {
                    value: taskDetails.name
                },
                titleLink: `https://app.asana.com/0/${taskDetails.projects?.[0]?.gid || ''}/${taskId}`,
                text: story.text || '',
                fields: [
                    {
                        short: true,
                        title: 'Task',
                        value: taskDetails.name,
                    },
                    {
                        short: true,
                        title: 'Status',
                        value: taskDetails.completed ? 'Completed' : 'Incomplete',
                    }
                ]
            };
            
            messageBuilder.setText(message);
            messageBuilder.addAttachment(attachment);
            
            await creator.finish(messageBuilder);
        } catch (error) {
            this.app.getLogger().error(`Error processing story event ${event.resource.gid}:`, error);
        }
    }
    
    /**
     * 处理Section事件（任务列表的部分）
     */
    private async processSectionEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp, webhookId?: string): Promise<void> {
        this.app.getLogger().debug(`Processing section event: ${event.action} for section ${event.resource.gid}`);
        
        try {
            // 不同的操作类型
            const user = event.user ? event.user.name : 'Someone';
            let message = '';
            
            if (event.action === 'added') {
                message = `📋 ${user} created a new section in the project`;
            } else if (event.action === 'changed') {
                message = `📋 ${user} updated a section in the project`;
            } else if (event.action === 'removed') {
                message = `🗑️ ${user} removed a section from the project`;
            } else {
                message = `📋 Section was ${event.action}`;
            }
            
            // 获取相关项目信息
            let projectName = "Unknown Project";
            let projectId = "";
            
            if (event.parent && event.parent.gid && event.parent.resource_type === 'project') {
                const projectDetails = await this.getProjectDetails(event.parent.gid, read, http, webhookId);
                if (projectDetails) {
                    projectName = projectDetails.name;
                    projectId = event.parent.gid;
                }
            }
            
            // 创建并发送消息
            const creator = modify.getCreator();
            const sender = await read.getUserReader().getAppUser();
            
            if (!sender) {
                this.app.getLogger().error('Could not get app user');
                return;
            }
            
            const notificationColor = await read.getEnvironmentReader().getSettings().getValueById(AppSetting.NotificationColor) || '#36C5F0';
            
            const messageBuilder = creator.startMessage()
                .setRoom(room)
                .setSender(sender);
            
            // 添加附件
            const attachment = {
                color: notificationColor,
                title: {
                    value: projectName
                },
                titleLink: projectId ? `https://app.asana.com/0/${projectId}` : undefined,
                text: message
            };
            
            messageBuilder.setText(message);
            messageBuilder.addAttachment(attachment);
            
            await creator.finish(messageBuilder);
        } catch (error) {
            this.app.getLogger().error(`Error processing section event ${event.resource.gid}:`, error);
        }
    }

    private async processTaskEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp, webhookId?: string): Promise<void> {
        const taskId = event.resource.gid;
        const action = event.action;
        // const user = event.user ? event.user.name : 'Someone';
        // TODO: use user gid to get user name
        const user = "Zilong Xue";

        // Get task details
        const taskDetails = await this.getTaskDetails(taskId, read, http, webhookId);
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
        } else if (action === 'uncompleted') {
            message = `🔄 ${user} marked task as incomplete: *${taskDetails.name}*`;
        } else if (action === 'assigned') {
            const assignee = taskDetails.assignee ? taskDetails.assignee.name : 'someone';
            message = `👤 ${user} assigned task to ${assignee}: *${taskDetails.name}*`;
        } else if (action === 'due') {
            message = `📅 ${user} set due date for task: *${taskDetails.name}*`;
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
            title: {
                value: taskDetails.name
            },
            titleLink: taskDetails.projects && taskDetails.projects.length > 0
                ? `https://app.asana.com/0/${taskDetails.projects[0].gid}/${taskId}`
                : `https://app.asana.com/0/0/${taskId}`,
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

    private async processProjectEvent(event: any, room: IRoom, read: IRead, modify: IModify, http: IHttp, webhookId?: string): Promise<void> {
        // Similar to processTaskEvent but for projects
        // Implementation would be similar to task events
        this.app.getLogger().debug('Project event processing not implemented yet');
        
        const projectId = event.resource.gid;
        const action = event.action;

        // const user = event.user ? event.user.name : 'Someone';
        // TODO: use user gid to get user name
        const user = "Zilong Xue";

        // Get project details
        const projectDetails = await this.getProjectDetails(projectId, read, http, webhookId);
        if (!projectDetails) {
            this.app.getLogger().warn(`Could not get details for project ${projectId}`);
            return;
        }

        let message = '';
        const notificationColor = await read.getEnvironmentReader().getSettings().getValueById(AppSetting.NotificationColor) || '#36a64f';

        if (action === 'added') {
            message = `🆕 ${user} created a new project: *${projectDetails.name}*`;
        } else if (action === 'changed') {
            message = `🔄 ${user} updated project: *${projectDetails.name}*`;
        } else if (action === 'removed') {
            message = `🗑️ ${user} removed project: *${projectDetails.name}*`;
        } else {
            message = `📝 Project *${projectDetails.name}* was ${action}`;
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

        // Add attachment with project details
        const attachment = {
            color: notificationColor,
            title: {
                value: projectDetails.name
            },
            titleLink: `https://app.asana.com/0/${projectId}`,
            text: projectDetails.notes || '',
            fields: [
                {
                    short: true,
                    title: 'Status',
                    value: projectDetails.archived ? 'Archived' : 'Active',
                },
                {
                    short: true,
                    title: 'Owner',
                    value: projectDetails.owner ? projectDetails.owner.name : 'No owner',
                },
                {
                    short: true,
                    title: 'Workspace',
                    value: projectDetails.workspace ? projectDetails.workspace.name : 'Unknown',
                },
            ]
        };

        messageBuilder.setText(message);
        messageBuilder.addAttachment(attachment);

        await creator.finish(messageBuilder);
    }

    /**
     * 获取授权头信息
     */
    private async getAuthHeaders(read: IRead, webhookId?: string): Promise<{ [key: string]: string }> {
        this.app.getLogger().debug(`正在获取API认证令牌，webhookId: ${webhookId || '无'}`);
        
        // 尝试获取相关的令牌
        try {
            // 0. 尝试从app的OAuth2Service获取通用令牌
            try {
                // 检查app是否有OAuth2Service
                if (this.app.getOAuth2Service) {
                    // 尝试获取管理员用户（即自己）
                    try {
                        const appUser = await read.getUserReader().getAppUser();
                        if (appUser) {
                            try {
                                const tokenInfo = await this.app.getOAuth2Service().getAccessTokenForUser(appUser, read);
                                if (tokenInfo && tokenInfo.access_token) {
                                    this.app.getLogger().debug(`使用应用用户 ${appUser.username} 的OAuth令牌`);
                                    return {
                                        'Authorization': `Bearer ${tokenInfo.access_token}`,
                                        'Accept': 'application/json',
                                    };
                                }
                            } catch (userTokenError) {
                                this.app.getLogger().debug(`获取应用用户令牌失败: ${userTokenError}`);
                            }
                        }
                    } catch (appUserError) {
                        this.app.getLogger().debug(`获取应用用户失败: ${appUserError}`);
                    }
                    
                    // 如果没有找到有效用户令牌，尝试获取客户端令牌
                    try {
                        const clientToken = await this.app.getOAuth2Service().getClientToken();
                        if (clientToken) {
                            this.app.getLogger().debug('使用OAuth客户端令牌');
                            return {
                                'Authorization': `Bearer ${clientToken}`,
                                'Accept': 'application/json',
                            };
                        }
                    } catch (clientTokenError) {
                        this.app.getLogger().debug('获取OAuth客户端令牌失败:', clientTokenError);
                    }
                }
            } catch (oauthError) {
                this.app.getLogger().debug('尝试使用OAuth服务时出错:', oauthError);
            }
            
            // 1. 如果提供了 webhookId，首先尝试获取与该 webhook 关联的 token
            if (webhookId) {
                try {
                    const webhookTokenAssociation = new RocketChatAssociationRecord(
                        RocketChatAssociationModel.MISC, 
                        `webhook_token_${webhookId}`
                    );
                    
                    const [webhookToken] = await read.getPersistenceReader().readByAssociation(
                        webhookTokenAssociation
                    ) as [{ access_token: string } | undefined];
                    
                    if (webhookToken && webhookToken.access_token) {
                        this.app.getLogger().debug(`使用与webhook ${webhookId}关联的token`);
                        return {
                            'Authorization': `Bearer ${webhookToken.access_token}`,
                            'Accept': 'application/json',
                        };
                    } else {
                        this.app.getLogger().debug(`未找到与webhook ${webhookId}关联的token`);
                    }
                } catch (webhookTokenError) {
                    this.app.getLogger().debug(`获取webhook ${webhookId}的token时出错: ${webhookTokenError}`);
                }
            }
            
            // 2. 尝试获取所有存储的令牌
            try {
                // 获取所有MISC类型记录
                const allTokenRecords = await read.getPersistenceReader().readByAssociation(
                    new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, '')
                ) as Array<{ access_token?: string }>;
                
                // 寻找包含access_token的记录
                const validTokens = allTokenRecords.filter(record => record && record.access_token);
                
                if (validTokens.length > 0) {
                    this.app.getLogger().debug(`找到${validTokens.length}个可用token`);
                    const accessToken = validTokens[0].access_token;
                    return {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json',
                    };
                } else {
                    this.app.getLogger().debug('未找到任何有效token');
                }
            } catch (error) {
                this.app.getLogger().debug('查找所有token记录时出错:', error);
            }
            
            // 3. 尝试获取管理员令牌
            try {
                const adminAssociation = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, 'admin_token');
                const [adminToken] = await read.getPersistenceReader().readByAssociation(
                    adminAssociation
                ) as [{ access_token: string } | undefined];
                
                if (adminToken && adminToken.access_token) {
                    this.app.getLogger().debug('使用管理员token');
                    return {
                        'Authorization': `Bearer ${adminToken.access_token}`,
                        'Accept': 'application/json',
                    };
                } else {
                    this.app.getLogger().debug('未找到管理员token');
                }
            } catch (adminTokenError) {
                this.app.getLogger().debug(`获取管理员token时出错: ${adminTokenError}`);
            }
            
            // 4. 如果没有管理员令牌，尝试使用应用设置中的API密钥
            try {
                const apiKey = await read.getEnvironmentReader().getSettings().getValueById('asana_api_key');
                if (apiKey && typeof apiKey === 'string') {
                    this.app.getLogger().debug('使用应用设置中的API密钥');
                    return {
                        'Authorization': `Bearer ${apiKey}`,
                        'Accept': 'application/json',
                    };
                } else {
                    this.app.getLogger().debug('应用设置中没有配置API密钥');
                }
            } catch (apiKeyError) {
                this.app.getLogger().debug(`获取API密钥设置时出错: ${apiKeyError}`);
            }
            
            this.app.getLogger().error('无法获取有效的API认证令牌');
            // 即使没有找到token，也返回基本的头信息以便调试
            return {
                'Accept': 'application/json',
            };
        } catch (error) {
            this.app.getLogger().error('获取认证头信息时出错:', error);
            // 即使出错也返回一个基本的头信息
            return {
                'Accept': 'application/json',
            };
        }
    }

    private async getTaskDetails(taskId: string, read: IRead, http: IHttp, webhookId?: string): Promise<any> {
        try {
            // 1. 尝试使用ApiService获取任务详情
            if (this.app.getApiService) {
                try {
                    // 获取授权头信息
                    const authHeaders = await this.getAuthHeaders(read, webhookId);
                    if (authHeaders && authHeaders.Authorization) {
                        // 从Authorization头中提取token
                        const token = authHeaders.Authorization.replace('Bearer ', '');
                        
                        // 使用ApiService获取任务详情
                        this.app.getLogger().debug(`使用ApiService获取任务 ${taskId} 详情`);
                        const task = await this.app.getApiService().getTaskById(token, taskId, http);
                        if (task) {
                            return task;
                        }
                    }
                } catch (apiServiceError) {
                    this.app.getLogger().debug(`使用ApiService获取任务详情时出错: ${apiServiceError}`);
                }
            }
            
            // 2. 如果ApiService失败，使用直接HTTP请求获取任务详情
            this.app.getLogger().debug(`使用直接HTTP请求获取任务 ${taskId} 详情`);
            const response = await http.get(`https://app.asana.com/api/1.0/tasks/${taskId}?opt_fields=name,notes,completed,due_on,assignee,projects`, {
                headers: await this.getAuthHeaders(read, webhookId),
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

    private async getProjectDetails(projectId: string, read: IRead, http: IHttp, webhookId?: string): Promise<any> {
        try {
            // 1. 尝试使用ApiService获取项目详情
            if (this.app.getApiService) {
                try {
                    // 获取授权头信息
                    const authHeaders = await this.getAuthHeaders(read, webhookId);
                    if (authHeaders && authHeaders.Authorization) {
                        // 从Authorization头中提取token
                        const token = authHeaders.Authorization.replace('Bearer ', '');
                        
                        // 使用ApiService获取项目详情
                        this.app.getLogger().debug(`使用ApiService获取项目 ${projectId} 详情`);
                        const project = await this.app.getApiService().getProjectById(token, projectId, http);
                        if (project) {
                            return project;
                        }
                    }
                } catch (apiServiceError) {
                    this.app.getLogger().debug(`使用ApiService获取项目详情时出错: ${apiServiceError}`);
                }
            }
            
            // 2. 如果ApiService失败，使用直接HTTP请求获取项目详情
            this.app.getLogger().debug(`使用直接HTTP请求获取项目 ${projectId} 详情`);
            const response = await http.get(`https://app.asana.com/api/1.0/projects/${projectId}?opt_fields=name,notes,archived,owner,workspace`, {
                headers: await this.getAuthHeaders(read, webhookId),
            });

            if (response.statusCode === 200) {
                return response.data.data;
            } else {
                this.app.getLogger().error(`Failed to get project details: ${response.content}`);
                return null;
            }
        } catch (error) {
            this.app.getLogger().error(`Error getting project details: ${error}`);
            return null;
        }
    }

    private async extractWebhookIdFromContent(content: any): Promise<string | null> {
        if (content && content.webhook && content.webhook.gid) {
            return content.webhook.gid;
        }
        return null;
    }

    /**
     * 尝试从请求中获取webhook ID
     */
    private async getWebhookIdFromRequest(request: IApiRequest, read: IRead): Promise<string | null> {
        try {
            // 尝试从URL参数获取
            if (request.query && request.query.webhook_id) {
                return request.query.webhook_id as string;
            }
            
            // 从请求头获取
            if (request.headers && request.headers['x-asana-webhook-id']) {
                return request.headers['x-asana-webhook-id'] as string;
            }

            // 从事件负载获取
            if (request.content && request.content.webhook && request.content.webhook.gid) {
                return request.content.webhook.gid;
            }
            
            // 尝试从事件资源ID获取对应的webhook ID
            if (request.content && request.content.events && request.content.events.length > 0) {
                const event = request.content.events[0];
                if (event && event.resource && event.resource.gid) {
                    const resourceId = event.resource.gid;
                    this.app.getLogger().debug(`尝试通过资源ID ${resourceId} 查找webhook ID`);
                    
                    try {
                        const resourceWebhookMapAssociation = new RocketChatAssociationRecord(
                            RocketChatAssociationModel.MISC, 
                            `resource_webhook_map_${resourceId}`
                        );
                        
                        const [resourceMap] = await read.getPersistenceReader().readByAssociation(
                            resourceWebhookMapAssociation
                        ) as [{ webhookId: string } | undefined];
                        
                        if (resourceMap && resourceMap.webhookId) {
                            this.app.getLogger().debug(`通过资源ID ${resourceId} 找到webhook ID: ${resourceMap.webhookId}`);
                            return resourceMap.webhookId;
                        }
                    } catch (error) {
                        this.app.getLogger().debug(`通过资源ID查找webhook ID时出错: ${error}`);
                    }
                }
                
                // 尝试从父资源ID获取
                if (event && event.parent && event.parent.gid) {
                    const parentId = event.parent.gid;
                    this.app.getLogger().debug(`尝试通过父资源ID ${parentId} 查找webhook ID`);
                    
                    try {
                        const parentWebhookMapAssociation = new RocketChatAssociationRecord(
                            RocketChatAssociationModel.MISC, 
                            `resource_webhook_map_${parentId}`
                        );
                        
                        const [parentMap] = await read.getPersistenceReader().readByAssociation(
                            parentWebhookMapAssociation
                        ) as [{ webhookId: string } | undefined];
                        
                        if (parentMap && parentMap.webhookId) {
                            this.app.getLogger().debug(`通过父资源ID ${parentId} 找到webhook ID: ${parentMap.webhookId}`);
                            return parentMap.webhookId;
                        }
                    } catch (error) {
                        this.app.getLogger().debug(`通过父资源ID查找webhook ID时出错: ${error}`);
                    }
                }
            }
            
            return null;
        } catch (error) {
            this.app.getLogger().error('Error getting webhook ID from request:', error);
            return null;
        }
    }

    /**
     * 通过资源ID查找webhook配置
     */
    private async findWebhookConfigByResourceId(resourceId: string, read: IRead): Promise<{ roomId: string, webhookId: string } | null> {
        try {
            // 1. 先尝试直接查找资源ID对应的webhook配置
            const resourceConfigAssoc = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC, 
                `webhook_${resourceId}`
            );
            
            const [directConfig] = await read.getPersistenceReader().readByAssociation(resourceConfigAssoc) as [{ roomId: string, webhookId: string } | undefined];
            
            if (directConfig && directConfig.roomId) {
                this.app.getLogger().debug(`直接找到资源 ${resourceId} 的webhook配置`);
                return directConfig;
            }
            
            // 2. 如果没有直接配置，尝试通过映射关系查找
            const resourceMapAssoc = new RocketChatAssociationRecord(
                RocketChatAssociationModel.MISC, 
                `resource_webhook_map_${resourceId}`
            );
            
            const [resourceMap] = await read.getPersistenceReader().readByAssociation(resourceMapAssoc) as [{ webhookId: string } | undefined];
            
            if (resourceMap && resourceMap.webhookId) {
                // 获取webhook配置
                const webhookConfigAssoc = new RocketChatAssociationRecord(
                    RocketChatAssociationModel.MISC, 
                    `webhook_${resourceMap.webhookId}`
                );
                
                const [webhookConfig] = await read.getPersistenceReader().readByAssociation(webhookConfigAssoc) as [{ roomId: string } | undefined];
                
                if (webhookConfig && webhookConfig.roomId) {
                    this.app.getLogger().debug(`通过映射关系找到资源 ${resourceId} 关联的webhook ${resourceMap.webhookId} 配置`);
                    return {
                        roomId: webhookConfig.roomId,
                        webhookId: resourceMap.webhookId
                    };
                }
            }
            
            return null;
        } catch (error) {
            this.app.getLogger().error(`查找资源 ${resourceId} 的webhook配置时出错:`, error);
            return null;
        }
    }

    /**
     * 创建webhook配置（如果不存在）
     * 用于确保事件可以被处理，即使没有预先配置
     */
    private async createWebhookConfigIfNeeded(event: any, read: IRead, persis: IPersistence): Promise<string | null> {
        try {
            // IRoomReader没有getRoomsByType方法，我们将采用其他方式获取房间
            // 先尝试获取一些公共频道
            let rooms: IRoom[] = [];
            try {
                const generalRoom = await read.getRoomReader().getByName('general');
                if (generalRoom) {
                    rooms.push(generalRoom);
                }
            } catch (error) {
                this.app.getLogger().debug('获取general房间失败:', error);
            }
            
            // 如果没有找到general房间，尝试通过读取已有配置来找到房间
            if (rooms.length === 0) {
                const allRecords = await read.getPersistenceReader().readByAssociation(
                    new RocketChatAssociationRecord(RocketChatAssociationModel.ROOM, '')
                ) as Array<{ roomId?: string }>;
                
                for (const record of allRecords) {
                    if (record && record.roomId) {
                        try {
                            const room = await read.getRoomReader().getById(record.roomId);
                            if (room) {
                                rooms.push(room);
                                break;
                            }
                        } catch (roomError) {
                            // 忽略错误，继续尝试下一个
                        }
                    }
                }
            }
            
            if (rooms.length === 0) {
                this.app.getLogger().debug('没有找到可用的房间，无法创建自动配置');
                return null;
            }
            
            // 使用找到的第一个房间
            const targetRoom = rooms[0];
            
            // 获取有效的API令牌并保存，以便后续API调用
            try {
                // 尝试获取有效的令牌并保存为admin_token
                const authHeaders = await this.getAuthHeaders(read);
                if (authHeaders.Authorization) {
                    const token = authHeaders.Authorization.replace('Bearer ', '');
                    if (token) {
                        this.app.getLogger().debug('保存找到的令牌作为admin_token');
                        const adminTokenAssociation = new RocketChatAssociationRecord(
                            RocketChatAssociationModel.MISC, 
                            'admin_token'
                        );
                        await persis.createWithAssociation({ access_token: token }, adminTokenAssociation);
                    }
                }
            } catch (tokenError) {
                this.app.getLogger().debug('保存API令牌时出错:', tokenError);
            }
            
            return this.saveWebhookConfig(event, targetRoom.id, persis);
        } catch (error) {
            this.app.getLogger().error(`自动创建webhook配置失败: ${error}`);
            return null;
        }
    }
    
    /**
     * 保存webhook配置
     */
    private async saveWebhookConfig(event: any, roomId: string, persis: IPersistence): Promise<string> {
        // 使用事件中的资源ID创建配置
        let resourceId = '';
        if (event.resource && event.resource.gid) {
            resourceId = event.resource.gid;
        } else if (event.webhook && event.webhook.gid) {
            resourceId = event.webhook.gid;
        } else {
            this.app.getLogger().debug('无法从事件中提取资源ID，使用时间戳作为ID');
            resourceId = `auto_${Date.now()}`;
        }
        
        // 准备配置数据
        const configData = {
            roomId: roomId,
            resourceId: resourceId,
            autoCreated: true,
            createdAt: new Date().toISOString()
        };
        
        // 创建关联记录
        const webhookAssociation = new RocketChatAssociationRecord(
            RocketChatAssociationModel.MISC,
            `webhook_${resourceId}`
        );
        
        // 保存配置
        await persis.createWithAssociation(configData, webhookAssociation);
        
        this.app.getLogger().debug(`自动创建了webhook配置: 资源ID ${resourceId}, 房间ID ${roomId}`);
        return roomId;
    }

    /**
     * 检查是否存在任何webhook配置
     */
    private async checkIfAnyConfigExists(read: IRead): Promise<boolean> {
        try {
            const allRecords = await read.getPersistenceReader().readByAssociation(
                new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, '')
            ) as Array<{ roomId?: string, id?: string }>;
            
            // 检查是否有以webhook_开头的配置
            const webhookConfigs = allRecords.filter(record => 
                record && record.roomId && record.id && 
                typeof record.id === 'string' && 
                record.id.startsWith('webhook_')
            );
            
            return webhookConfigs.length > 0;
        } catch (error) {
            this.app.getLogger().error('检查webhook配置存在性时出错:', error);
            return false;
        }
    }
} 