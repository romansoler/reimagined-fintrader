import { Client, GatewayIntentBits, Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

export class DiscordProvider extends EventEmitter {
    /**
     * @param {object} config
     * @param {string} config.token - Discord bot token
     * @param {string} config.channelId - Channel ID to monitor
     * @param {string[]} [config.allowedBotNames] - Bot/webhook names to allow (e.g., ['AO Trades'])
     */
    constructor({ token, channelId, allowedBotNames = [] }) {
        super();
        this.token = token;
        this.channelId = channelId;
        this.connected = false;
        this.client = null;

        // Allowed bot/app names (case-insensitive) — these are NOT filtered out
        this.allowedBotNames = new Set(
            (allowedBotNames.length > 0 ? allowedBotNames : ['AO Trades'])
                .map(n => n.toLowerCase())
        );
    }

    async connect() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });

        this.client.on(Events.ClientReady, () => {
            logger.info('Discord', `Logged in as ${this.client.user.tag}`);
            logger.info('Discord', `Monitoring channel: ${this.channelId}`);
            logger.info('Discord', `Allowed bot sources: ${[...this.allowedBotNames].join(', ')}`);
            this.connected = true;
            this.emit('connected', this.client.user.tag);
        });

        // --- New message ---
        this.client.on(Events.MessageCreate, (message) => {
            if (!this._shouldProcess(message)) return;

            const payload = this._extractPayload(message);
            logger.debug('Discord', `New message from ${payload.author}: ${payload.content.slice(0, 80)}`);
            this.emit('message', payload);
        });

        // --- Message edit ---
        this.client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
            // oldMessage may be partial (uncached) — that's OK
            if (!newMessage.channel || newMessage.channel.id !== this.channelId) return;

            // Fetch full message if partial
            const msg = newMessage.partial ? null : newMessage;
            if (!msg) {
                // Try to fetch the full message
                newMessage.fetch().then(fetched => {
                    const payload = this._extractPayload(fetched);
                    const oldPayload = oldMessage?.content
                        ? this._extractPayload(oldMessage)
                        : null;

                    logger.debug('Discord', `Message edited: ${payload.messageId} | ${payload.content.slice(0, 80)}`);
                    this.emit('messageEdit', {
                        ...payload,
                        oldContent: oldPayload?.content || null,
                        isEdit: true,
                    });
                }).catch(err => {
                    logger.warn('Discord', `Failed to fetch edited message: ${err.message}`);
                });
                return;
            }

            const payload = this._extractPayload(msg);
            const oldPayload = oldMessage?.content
                ? this._extractPayload(oldMessage)
                : null;

            logger.debug('Discord', `Message edited: ${payload.messageId} | ${payload.content.slice(0, 80)}`);
            this.emit('messageEdit', {
                ...payload,
                oldContent: oldPayload?.content || null,
                isEdit: true,
            });
        });

        this.client.on(Events.Error, (error) => {
            logger.error('Discord', `Client error: ${error.message}`);
            this.emit('error', error);
        });

        this.client.on(Events.ShardDisconnect, () => {
            logger.warn('Discord', 'Disconnected from gateway');
            this.connected = false;
            this.emit('disconnected');
        });

        this.client.on(Events.ShardReconnecting, () => {
            logger.info('Discord', 'Reconnecting to gateway...');
        });

        try {
            await this.client.login(this.token);
        } catch (error) {
            logger.error('Discord', `Login failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * Determine if a message should be processed.
     * Allows whitelisted bot/webhook names, filters out all other bots.
     */
    _shouldProcess(message) {
        if (message.channel.id !== this.channelId) return false;

        if (message.author.bot || message.webhookId) {
            // Allow whitelisted bot names
            const authorName = (message.author.username || message.author.tag || '').toLowerCase();
            if (this.allowedBotNames.has(authorName)) {
                return true;
            }
            // Also check if any allowed name is a substring (for "AO Trades [APP]")
            for (const allowed of this.allowedBotNames) {
                if (authorName.includes(allowed)) return true;
            }
            return false;
        }

        return true;
    }

    /**
     * Extract a standardized payload from a Discord message.
     * Handles embeds (the signal body is usually in an embed).
     */
    _extractPayload(message) {
        // Concatenate all text: message content + embed descriptions
        let fullContent = message.content || '';

        if (message.embeds && message.embeds.length > 0) {
            for (const embed of message.embeds) {
                if (embed.description) {
                    fullContent += '\n' + embed.description;
                }
                if (embed.title) {
                    fullContent = embed.title + '\n' + fullContent;
                }
                // Also capture embed fields
                if (embed.fields?.length > 0) {
                    for (const field of embed.fields) {
                        fullContent += `\n${field.name}: ${field.value}`;
                    }
                }
                // Footer may contain "Last Updated: ..."
                if (embed.footer?.text) {
                    fullContent += '\n' + embed.footer.text;
                }
            }
        }

        return {
            content: fullContent.trim(),
            messageId: message.id,
            channelId: message.channel.id,
            author: message.author?.username || message.author?.tag || 'unknown',
            timestamp: message.createdTimestamp,
            editedTimestamp: message.editedTimestamp || null,
        };
    }

    /** Update the channel being monitored. */
    setChannel(channelId) {
        this.channelId = channelId;
        logger.info('Discord', `Now monitoring channel: ${channelId}`);
    }

    /** Check if connected. */
    isConnected() {
        return this.connected && this.client?.ws?.status === 0;
    }

    /** Gracefully disconnect. */
    async disconnect() {
        if (this.client) {
            this.client.destroy();
            this.connected = false;
            logger.info('Discord', 'Disconnected');
        }
    }
}
