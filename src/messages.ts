import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MattermostApi } from './session.js';

const id = z.string().regex(/^[a-z0-9]{26}$/, '必須是 26 個小寫英數字元的 Mattermost ID。');
const message = z.string().max(16383, '訊息不可超過 16383 個字元。')
  .refine((value) => value.trim().length > 0, '訊息不可為空白。');
const channelSchema = z.object({
  id, team_id: z.string(), name: z.string(), display_name: z.string(),
  type: z.enum(['O', 'P', 'D', 'G']), delete_at: z.number(),
});
const postSchema = z.object({
  id, channel_id: id, root_id: z.string(), user_id: id, message: z.string(),
  create_at: z.number(), update_at: z.number(), delete_at: z.number(), reply_count: z.number().optional(),
});
const threadSchema = z.object({
  order: z.array(id), posts: z.record(id, postSchema),
  next_post_id: z.string().optional(), prev_post_id: z.string().optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, writing = false): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(writing
    ? '訊息回應格式錯誤，但訊息可能已送出。請先查詢確認，不要直接重送。'
    : 'Mattermost API 回應格式錯誤。');
  return parsed.data;
}

/** 所有寫入先確認頻道及討論串歸屬，不重試 POST。 */
export class MessageService {
  constructor(private api: MattermostApi) {}

  async getChannel(channelId: string) {
    return parse(channelSchema, await this.api.request(`/channels/${channelId}`));
  }

  async getPost(postId: string) {
    return parse(postSchema, await this.api.request(`/posts/${postId}`));
  }

  async getThread(postId: string) {
    return parse(threadSchema, await this.api.request(`/posts/${postId}/thread`));
  }

  private async requireChannel(channelId: string) {
    const channel = await this.getChannel(channelId);
    if (channel.id !== channelId || channel.delete_at !== 0) throw new Error('頻道不符或已封存，未發送訊息。');
  }

  async createPost(channelId: string, text: string) {
    await this.requireChannel(channelId);
    return parse(postSchema, await this.api.request('/posts', undefined, {
      method: 'POST', body: { channel_id: channelId, message: text },
    }), true);
  }

  async replyToThread(channelId: string, postId: string, text: string) {
    await this.requireChannel(channelId);
    const target = await this.getPost(postId);
    if (target.id !== postId || target.channel_id !== channelId || target.delete_at !== 0) {
      throw new Error('目標訊息不屬於指定頻道或已刪除，未發送回覆。');
    }
    const root = target.root_id ? await this.getPost(target.root_id) : target;
    if (root.id !== (target.root_id || target.id) || root.root_id || root.channel_id !== channelId || root.delete_at !== 0) {
      throw new Error('討論串根訊息不符或已刪除，未發送回覆。');
    }
    return parse(postSchema, await this.api.request('/posts', undefined, {
      method: 'POST', body: { channel_id: channelId, root_id: root.id, message: text },
    }), true);
  }
}

export function registerMessageTools(server: McpServer, api: MattermostApi) {
  const service = new MessageService(api);
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  const writing = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const result = async (call: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await call(), null, 2) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : '操作失敗。' }] };
    }
  };

  server.registerTool('mattermost_get_channel', {
    description: '以頻道 ID 查詢頻道名稱、類型及封存狀態。唯讀操作。',
    inputSchema: { channelId: id }, annotations: readOnly,
  }, ({ channelId }) => result(() => service.getChannel(channelId)));

  server.registerTool('mattermost_get_post', {
    description: '取得單則訊息，包含 channel_id 及討論串 root_id。唯讀操作。',
    inputSchema: { postId: id }, annotations: readOnly,
  }, ({ postId }) => result(() => service.getPost(postId)));

  server.registerTool('mattermost_get_thread', {
    description: '取得指定訊息所屬的討論串及回覆。唯讀操作。',
    inputSchema: { postId: id }, annotations: readOnly,
  }, ({ postId }) => result(() => service.getThread(postId)));

  server.registerTool('mattermost_create_post', {
    description: '以目前登入者身分，在指定頻道實際發送一則新訊息。非唯讀，須有使用者授權；逾時不得直接重送。',
    inputSchema: { channelId: id, message }, annotations: writing,
  }, ({ channelId, message: text }) => result(() => service.createPost(channelId, text)));

  server.registerTool('mattermost_reply_to_thread', {
    description: '在指定頻道實際回覆討論串。postId 可為根訊息或既有回覆，會自動找出 root_id 並檢查頻道歸屬。非唯讀，須有使用者授權。',
    inputSchema: { channelId: id, postId: id, message }, annotations: writing,
  }, ({ channelId, postId, message: text }) => result(() => service.replyToThread(channelId, postId, text)));
}
