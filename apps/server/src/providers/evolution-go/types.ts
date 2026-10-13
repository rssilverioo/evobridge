/**
 * Evolution Go wire types, verified against evolution-go v0.7.2 source (not the docs,
 * which still describe Evolution API v2 payloads). See docs/research/evolution-go.md.
 */

export interface EvoEnvelope<T> {
  message?: string;
  data: T;
  error?: string;
}

/** `GET /instance/all` and `GET /instance/info/:id` items (pkg/instance/model/instance_model.go). */
export interface EvoInstance {
  id: string;
  name: string;
  token: string;
  webhook: string;
  events: string;
  rabbitmqEnable: string;
  websocketEnable: string;
  natsEnable: string;
  jid: string;
  connected: boolean;
  disconnect_reason?: string;
  client_name?: string;
}

/** Body of `POST /instance/connect`: the only way to set the instance webhook. Overwrites all fields. */
export interface EvoConnectBody {
  webhookUrl: string;
  subscribe: string[];
  rabbitmqEnable: string;
  websocketEnable: string;
  natsEnable: string;
}

/** Webhook body for every event (whatsmeow.go). */
export interface EvoWebhook {
  event: string;
  data: unknown;
  instanceId?: string;
  instanceToken?: string;
  instanceName?: string;
  state?: string;
}

/** whatsmeow MessageInfo as serialized (PascalCase keys). */
export interface EvoMessageInfo {
  Chat: string;
  Sender: string;
  SenderAlt?: string;
  RecipientAlt?: string;
  IsFromMe: boolean;
  IsGroup: boolean;
  AddressingMode?: string;
  ID: string;
  Type?: string;
  PushName?: string;
  Timestamp?: string;
  MediaType?: string;
  Edit?: string;
  DeviceSentMeta?: { DestinationJID?: string } | null;
}

/** waE2E.Message subset, protobuf camelCase keys. Media and base64 are added by Evolution Go. */
export interface WaMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string; contextInfo?: WaContextInfo };
  imageMessage?: WaMedia;
  videoMessage?: WaMedia & { seconds?: number };
  audioMessage?: WaMedia & { seconds?: number; PTT?: boolean };
  documentMessage?: WaMedia & { fileName?: string; title?: string };
  stickerMessage?: WaMedia;
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string };
  liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
  contactMessage?: { displayName?: string; vcard?: string };
  contactsArrayMessage?: { displayName?: string; contacts?: Array<{ displayName?: string; vcard?: string }> };
  reactionMessage?: { key?: WaKey; text?: string };
  protocolMessage?: { type?: number; key?: WaKey; editedMessage?: WaMessage };
  pollCreationMessage?: { name?: string; options?: Array<{ optionName?: string }> };
  pollCreationMessageV3?: { name?: string; options?: Array<{ optionName?: string }> };
  ephemeralMessage?: { message?: WaMessage };
  viewOnceMessage?: { message?: WaMessage };
  viewOnceMessageV2?: { message?: WaMessage };
  viewOnceMessageV2Extension?: { message?: WaMessage };
  documentWithCaptionMessage?: { message?: WaMessage };
  editedMessage?: { message?: WaMessage };
  buttonsResponseMessage?: { selectedDisplayText?: string };
  listResponseMessage?: { title?: string };
  templateButtonReplyMessage?: { selectedDisplayText?: string };
  /** Injected by Evolution Go when WEBHOOK_FILES=true and MinIO is off. Raw base64, no data: prefix. */
  base64?: string;
  /** Injected when MinIO is on: 7-day presigned URL. */
  mediaUrl?: string;
  mimetype?: string;
}

export interface WaMedia {
  URL?: string;
  mimetype?: string;
  caption?: string;
  fileLength?: number | string;
  contextInfo?: WaContextInfo;
}

export interface WaContextInfo {
  stanzaID?: string;
  participant?: string;
  quotedMessage?: WaMessage;
  isForwarded?: boolean;
}

export interface WaKey {
  ID?: string;
  remoteJID?: string;
  fromMe?: boolean;
  participant?: string;
}

export interface EvoMessageData {
  Info: EvoMessageInfo;
  Message?: WaMessage;
  IsEdit?: boolean;
  IsViewOnce?: boolean;
  isQuoted?: boolean;
  quoted?: { stanzaID?: string; quotedMessage?: WaMessage };
  /** Present on UndecryptableMessage. */
  UnavailableType?: string;
}

export interface EvoReceiptData {
  Chat: string;
  Sender: string;
  IsFromMe: boolean;
  IsGroup: boolean;
  MessageIDs: string[];
  Timestamp?: string;
  Type?: string;
}

export interface EvoSendResult {
  Info?: { ID?: string; Timestamp?: string };
}

export interface EvoSendTextBody {
  number: string;
  text: string;
  id?: string;
  quoted?: { messageId: string; participant: string };
}

export type EvoMediaType = 'image' | 'video' | 'audio' | 'document';

/** `GET /user/contacts` item (pkg/user/service ContactInfo). */
export interface EvoContact {
  Jid: string;
  Found?: boolean;
  FirstName?: string;
  FullName?: string;
  PushName?: string;
  BusinessName?: string;
}

/** Subscriptions EvoBridge needs on the instance webhook. */
export const REQUIRED_EVENTS = ['MESSAGE', 'SEND_MESSAGE', 'READ_RECEIPT', 'CONNECTION'] as const;
