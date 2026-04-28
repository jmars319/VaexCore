export type ChatBadge = {
  set_id: string;
  id: string;
  info: string;
};

export type ChatMessageEvent = {
  broadcasterUserId: string;
  broadcasterLogin: string;
  broadcasterName: string;
  chatterUserId: string;
  chatterLogin: string;
  chatterName: string;
  messageId: string;
  text: string;
  badges: ChatBadge[];
};

export type EventSubMessage = {
  metadata: {
    message_id: string;
    message_type:
      | "session_welcome"
      | "session_keepalive"
      | "notification"
      | "session_reconnect"
      | "revocation";
    message_timestamp: string;
    subscription_type?: string;
    subscription_version?: string;
  };
  payload: {
    session?: {
      id: string;
      status: string;
      connected_at: string;
      keepalive_timeout_seconds: number;
      reconnect_url: string | null;
    };
    subscription?: {
      id: string;
      status: string;
      type: string;
      version: string;
    };
    event?: {
      broadcaster_user_id: string;
      broadcaster_user_login: string;
      broadcaster_user_name: string;
      chatter_user_id: string;
      chatter_user_login: string;
      chatter_user_name: string;
      message_id: string;
      message?: {
        text: string;
      };
      badges?: ChatBadge[];
    };
  };
};
