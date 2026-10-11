# PHOTON_NOTES: verified external API surface for Batman

Written by the docs-researcher subagent on 2026-10-10. Documentation version: Photon **Stable**.

Ground truth, in order of authority:

1. Installed type definitions (pnpm store under `C:\Users\yalam\batman\node_modules\.pnpm\...`, symlinked from `apps/server/node_modules`). Versions: spectrum-ts 12.10.1, @spectrum-ts/core 12.10.1, @spectrum-ts/imessage 12.10.1, @spectrum-ts/terminal 12.10.1, @photon-ai/advanced-imessage 2.2.0, livekit-server-sdk 2.19.1, @livekit/protocol 1.51.0, @livekit/rtc-node 1.1.0 (ffi bindings 0.12.73), openai 7.32.0, @anthropic-ai/sdk 0.133.0, zod 4.6.5.
2. Photon Stable docs: https://photon.codes/docs/llms.txt and https://photon.codes/docs/llms-full.txt (no `/docs/beta/` pages were used).
3. Spectrum OpenAPI: https://spectrum.photon.codes/openapi/json (title "Spectrum Cloud External API", version 1.0.0, server `https://spectrum.photon.codes`).
4. LiveKit docs: https://docs.livekit.io (`.md` suffix pages).
5. OpenAI: installed types only (platform.openai.com is JS-rendered; nothing beyond the installed `.d.ts` was verifiable).

Path shorthands used below:

- `CORE` = `C:\Users\yalam\batman\node_modules\.pnpm\@spectrum-ts+core@12.10.1_typescript@7.0.2\node_modules\@spectrum-ts\core\dist\app-QE1pS82j.d.ts`
- `IMSG` = `C:\Users\yalam\batman\apps\server\node_modules\@spectrum-ts\imessage\dist\index.js` (runtime) and `...\dist\index.d.ts` (types)
- `AIM` = `C:\Users\yalam\batman\apps\server\node_modules\@photon-ai\advanced-imessage\dist\`
- `LKS` = `C:\Users\yalam\batman\apps\server\node_modules\livekit-server-sdk\dist\`
- `RTC` = `C:\Users\yalam\batman\apps\server\node_modules\@livekit\rtc-node\dist\`
- `ANTH` = `C:\Users\yalam\batman\apps\server\node_modules\@anthropic-ai\sdk\`
- `OAI` = `C:\Users\yalam\batman\apps\server\node_modules\openai\`

---

## Headline finding: the gRPC address for advanced-imessage

Source: `IMSG` runtime, function `createCloudClients` (lines 459 to 581) and `definedIMessage.lifecycle.createClient` (line 2976).

```js
// dedicated line (one client per instanceId in tokenData.auth):
createGrpcClient({
  address: `${instanceId}.imsg.photon.codes:443`,
  autoIdempotency: true, retry: true, tls: true,
  token: async () => { await renewal.refreshIfNeeded(); return tokenData.auth[instanceId] ?? initialToken; }
})

// shared pool (tokenData.type === "shared"):
const address = process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";
createGrpcClient({ address, autoIdempotency: true, retry: true, tls: true,
  token: async () => { await renewal.refreshIfNeeded(); return tokenData.token; } })
```

So:

- **Shared pool token (Free/Pro):** `IMESSAGE_GRPC_ADDRESS=imessage.spectrum.photon.codes:443`, `tls: true`, bearer = `data.token` from `POST /projects/{id}/imessage/tokens`. The SDK honours an env override `SPECTRUM_IMESSAGE_ADDRESS`.
- **Dedicated line (Business):** `{instanceId}.imsg.photon.codes:443` where `instanceId` is each key of `data.auth` (and `data.numbers[instanceId]` is that line's E.164). Stable docs show the same pattern as an example: `line-1.imsg.photon.codes:443` (llms-full.txt line 2384).
- Tokens are minted by `@spectrum-ts/core` `cloud.issueImessageTokens(projectId, projectSecret)` which POSTs `https://spectrum.photon.codes/projects/${projectId}/imessage/tokens` with Basic auth (core `dist/index.js` line 2920) and renews at 80% of `expiresIn` (`createTokenRenewal`). The shared-mode client is tagged with the sentinel phone `"shared"` (`SHARED_PHONE`, `IMSG` line 255) and `isSharedMode(clients)` is `clients.length === 1 && clients[0].phone === "shared"` (line 1995).

---

## A. spectrum-ts 12.10.1

### Import paths (confirmed from `spectrum-ts/package.json` `exports`)

| Path | Resolves to |
|---|---|
| `spectrum-ts` | `export * from "@spectrum-ts/core"` (Spectrum, Emoji, voice, text, contact, attachment, reaction, read, reply, markdown, ...) |
| `spectrum-ts/providers/imessage` | `export * from "@spectrum-ts/imessage"` (imessage, nativeContactCard, background, effect, customizedMiniApp, read) |
| `spectrum-ts/providers/terminal` | `export * from "@spectrum-ts/terminal"` (terminal) |
| `spectrum-ts/providers` | `{ imessage, slack, telegram, terminal, whatsappBusiness }` |
| `spectrum-ts/authoring` | provider-authoring helpers incl. `ensureM4a` |

All three paths in the spec are correct.

### `Spectrum(...)` constructor (`CORE` lines 6856 to 6893)

```ts
interface SpectrumOptions { flattenGroups?: boolean; logLevel?: LogLevel; }
interface SpectrumFactoryOptions<Providers> { options?: SpectrumOptions; providers: [...Providers]; telemetry?: boolean; webhookSecret?: string; }
declare function Spectrum<const Providers extends PlatformProviderConfig[]>(options: { projectId: string; projectSecret: string; } & SpectrumFactoryOptions<Providers>): Promise<SpectrumInstance<Providers> & { readonly config: ProjectData }>;
declare function Spectrum<const Providers extends PlatformProviderConfig[]>(options: { projectId?: never; projectSecret?: never; } & SpectrumFactoryOptions<Providers>): Promise<SpectrumInstance<Providers>>;
```

- `LogLevel` is `"debug" | "info" | "warn" | "error" | "silent"` (from `@photon-ai/otel`, `dist/index.d.ts` line 224). `env.LOG_LEVEL ?? "info"` must be narrowed to this union; pino levels such as `trace` or `fatal` are not valid.
- `logLevel` applies process wide and overrides the `LOG_LEVEL` env var.
- Returned instance (`SpectrumInstance`, `CORE` 6805 to 6854): `messages: AsyncIterable<[Space, Message]>`, `stop(): Promise<void>`, `send(space, content)`, `edit(message, newContent)`, `responding(space, fn)`, `webhook(request, handler)`. With credentials, `app.config: ProjectData { id, name, profile, slug }`.
- The imessage provider throws if `projectId`/`projectSecret` are missing and no explicit `clients` are configured (`IMSG` line 2988).

### `app.messages` and `Message` (`CORE` lines 502 to 545)

```ts
interface Message<TPlatform extends string = string, TSender extends User = User, TSpace extends Space = Space> {
  content: Content;
  direction: "inbound" | "outbound";
  edit(newContent: ContentInput): Promise<void>;
  readonly id: string;
  platform: TPlatform;
  react(reaction: string): Promise<(Message<TPlatform, AgentSender, TSpace> & { content: Reaction }) | undefined>;
  read(): Promise<void>;
  reply(content: ContentInput): Promise<Message<TPlatform, AgentSender, TSpace> | undefined>;
  reply(...content: [ContentInput, ContentInput, ...ContentInput[]]): Promise<Message<TPlatform, AgentSender, TSpace>[]>;
  sender: TSender | undefined;
  space: TSpace;
  timestamp: Date;
  unsend(): Promise<void>;
}
```

- Iteration shape `for await (const [space, message] of app.messages)` is confirmed.
- `message.id` for iMessage is the iMessage GUID: inbound `id: event.message.guid` (`IMSG` lines 2456, 2465), outbound `id: sent.guid` (lines 1506, 2684). Multi-part inbound messages (text plus attachments) yield one `Message` per part; part 0 keeps the GUID, later parts use `formatChildId(i, guid)` with `parentId` set (lines 1259 to 1265). Dedupe on `message.id` therefore works, but a voice note with a caption may arrive as two messages sharing a parent.
- `message.sender` after `imessage(message)` narrowing has `{ id: string; address?: string; country?: string; service?: "iMessage" | "SMS" | "RCS" | "unknown" }` (`IMSG` lines 274 to 278; docs llms-full.txt 2480 to 2500). `id` is the E.164 or email and is the same handle `space.create` accepts.

### `message.content` union (`CORE` `contentSchema`, `type Content = z.infer<typeof contentSchema>` line 7923)

Discriminated on `type`. Members relevant to the spec:

| type | shape |
|---|---|
| `text` | `{ type: "text"; text: string }` (line 1460) |
| `voice` | `{ type: "voice"; id?: string; name?: string; mimeType: string; duration?: number; size?: number; read(): Promise<Buffer>; stream(): Promise<ReadableStream> }` (line 1555) |
| `attachment` | `{ type: "attachment"; id: string; name: string; mimeType: string; size?: number; read(): Promise<Buffer>; stream(): Promise<ReadableStream> }` (line 6) |
| `contact` | `{ type: "contact"; user?: {__platform; id}; name?: {formatted?, first?, last?, ...}; phones?: {value, type?}[]; emails?: {value, type?}[]; addresses?: [...]; org?; urls?: string[]; birthday?; note?; photo?; raw? }` (line 188) |
| `reaction` | `{ type: "reaction"; emoji: string; target: Message }` (line 275) |
| `read` | `{ type: "read"; target: Message }` (line 1050) |
| `poll_option` | `{ type: "poll_option"; option: {title}; poll: {type:"poll"; title; options}; selected: boolean; title: string }` (line 994) |

Other union members that can appear and must fall into an ignore branch: `markdown`, `richlink`, `group` (items[]), `app`, `poll`, `reply`, `edit`, `unsend`, `typing`, `rename`, `avatar`, `addMember`, `removeMember`, `leaveSpace`, `streamText`, `effect`, `custom`.

- Inbound iMessage voice notes: the provider maps an `isAudioMessage` attachment to `voice` content with `mimeType` normalised from Apple's UTI; Apple audio messages are usually CAF, exposed as `audio/x-caf` (`IMSG` lines 815 to 826, 1143). `content.read()` returns a `Buffer`. The spec's "convert with ffmpeg if needed" is required for STT in practice.
- Inbound vCards (`text/vcard`, `text/x-vcard`, `text/directory`, `application/vcard`, `application/x-vcard`, or `.vcf` file name) are parsed to `contact` content; on parse failure they fall back to `attachment` (`IMSG` lines 862 to 876, 1150 to 1160). The provider has no special handling for Apple location pins (`.loc.vcf`), so the spec's Spike S4 parsing (look at `contact.urls` or the raw vCard) stands.
- Read receipts arrive as `content.type === "read"` on `app.messages` for both shared and dedicated lines (docs llms-full.txt line 1616).

### `Space` (`CORE` lines 360 to 500)

```ts
interface Space<_Def = unknown> {
  readonly __platform: string; readonly id: string;
  send(content: ReactionBuilder): Promise<(Message<string, AgentSender> & { content: Reaction }) | undefined>;
  send(content: ContentInput): Promise<Message<string, AgentSender> | undefined>;
  send(...content: [ContentInput, ContentInput, ...ContentInput[]]): Promise<Message<string, AgentSender>[]>;
  responding<T>(fn: () => T | Promise<T>): Promise<T>;
  startTyping(): Promise<void>; stopTyping(): Promise<void>;
  read(message: Message): Promise<void>;
  getMessage(id: string): Promise<Message | undefined>;
  edit(message: Message | undefined, newContent: ContentInput): Promise<void>;
  unsend(message: Message | undefined): Promise<void>;
  add(users: MemberInput): Promise<void>; remove(users: MemberInput): Promise<void>; leave(): Promise<void>;
  rename(displayName: string): Promise<void>; avatar(...): Promise<void>; getAvatar(); getDisplayName(); getMembers(): Promise<User[]>;
}
```

- `ContentInput = string | ContentBuilder`; `space.send("plain text")` works without `text()`.
- `send` resolves `undefined` when the platform skips unsupported content, so keep the returned `Message` optional when storing check-in message ids.
- Narrowed iMessage space (`imessage(space)`): `{ id; type: "dm" | "group"; phone: string }` plus actions `background(...)` and `shareContactCard()` (`IMSG` d.ts lines 815 to 826). `phone` is the E.164 of the dedicated line or the literal `"shared"`.

### Builders

- `text(source: string): ContentBuilder` (`CORE` 1484). Also accepts a stream source.
- `voice(input: string | Buffer | URL, options?: { mimeType?: string; name?: string; duration?: number }): ContentBuilder` (`CORE` 1576). The spec's `voice(buffer, { name: "note.m4a", mimeType: "audio/mp4", duration })` matches.
  - Outbound path (`IMSG` `uploadVoice`, line 1866): `ensureM4a(await content.read(), content.mimeType)` then `attachments.upload({ data, fileName })` then `messages.sendAttachment(chat, guid, { isAudioMessage: true })`.
  - `ensureM4a(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; duration?: number }>` (core `dist/authoring.d.ts` line 27). It passes the buffer through unchanged when the MIME type is one of `audio/mp4`, `audio/mp4a-latm`, `audio/x-m4a`, `audio/aac`, `audio/aacp` or the bytes carry an `ftyp` M4A brand; otherwise it transcodes and throws `"voice content: input is not m4a/aac and ffmpeg is unavailable. Install ffmpeg-static or ensure ffmpeg is on PATH."` when ffmpeg is missing (core `dist/authoring.js`). `ffmpeg-static` is an optional peer dependency of `@spectrum-ts/core`.
- `Emoji` (`CORE` 1583): `Emoji.like = "👍"`, also `love`, `dislike`, `laugh`, `emphasize`, `question`, and a full emoji table. `message.react(Emoji.like)` is `react(reaction: string)`.
- `reply(content, target)` and `message.reply(content)` confirmed (`CORE` 1433, 532).
- Native contact card: `nativeContactCard(): ContentBuilder` exported from `spectrum-ts/providers/imessage`; `space.send(nativeContactCard())` or `imessage(space).shareContactCard()`. Runtime calls `chats.shareContactInfo(chat)` on the gRPC client (`IMSG` d.ts lines 76 to 100; docs llms-full.txt 3049 to 3080). iMessage only; shared mode supported.

### Platform narrowing and space creation (`CORE` `Platform<Def>` lines 6674 to 6690, `SpaceNamespace` 6616 to 6630)

```ts
interface Platform<Def> {
  config(config?: ConfigInput<Def>): PlatformProviderConfig<Def>;
  is(input: Message): input is PlatformMessage<Def>; is(input: Space): input is PlatformSpace<Def>;
  <Providers>(spectrum: SpectrumLike<Providers>): PlatformInstance<Def>;   // imessage(app)
  (space: Space): PlatformSpace<Def>;                                       // imessage(space)
  (message: Message): PlatformMessage<Def>;                                 // imessage(message)
}
type PlatformInstance<Def> = { readonly messages: AsyncIterable<[PlatformSpace<Def>, PlatformMessage<Def>]>; readonly space: SpaceNamespace<Def>; user(userID: string): Promise<PlatformUser<Def>>; ... }
interface SpaceNamespace<Def> {
  create(users: SpaceUserLike<Def> | SpaceUserLike<Def>[], ...params: SpaceParamsArgs<Def>): Promise<PlatformSpace<Def>>;
  get(id: string, ...params: SpaceParamsArgs<Def>): Promise<PlatformSpace<Def>>;
}
type SpaceUserLike<Def> = PlatformUser<Def> | string;
```

- The spec's `imessage(app).space.create(await imessage(app).user(guardianE164))` is correct. `space.create("+1...")` with a raw string also type checks. iMessage `user.resolve` is a pure `({ id: input.userID })` (`IMSG` line 2998), no network call.
- iMessage `space.create` runtime (`IMSG` 3005 to 3027): in shared mode it returns `{ id: "any;-;" + address, type: "dm", phone: "shared" }` without a network call and throws `UnsupportedError` for more than one user. In dedicated mode it calls `chats.create(addresses)` and returns `chat.guid`; optional params `{ phone }` select the line.
- `space.get(chatGuid)` requires `params.phone` once two or more dedicated lines exist (docs llms-full.txt 2444).
- Shared pool restriction (docs llms-full.txt 4823 to 4826): a shared line will only message recipients registered as **users** of the project; anything else fails with `Target not allowed for this project`. This makes Spike S5 a hard requirement, not a question: guardians must be created via `POST /projects/{id}/users/` before the first outbound message.

### Terminal provider (`@spectrum-ts/terminal` `dist/index.d.ts`)

- `terminal.config({ commands?: { name: string; description?: string }[] })`. No other config keys (strict schema).
- `message.platform === "terminal"`; sender is `{ id: string }`; space is `{ id: string }`. Inbound content types: `text`, `attachment`, `voice`, `contact`, `custom`, plus reactions.
- Spawns a child process and hijacks the console (`TerminalClient { proc, session, hijack, knownChats }`).

### `app.stop()`

`stop(): Promise<void>` on `SpectrumInstance` (`CORE` 6814). The imessage provider's `destroyClient` disposes token renewal and closes every gRPC client (`IMSG` 2992 to 2996). No signal handlers are registered by the SDK.

### Quotas (docs llms-full.txt 2455 to 2458, 4676 to 4679)

5,000 outbound messages per server per day (hard limit) and 50 new conversations per line per day. Matches spec 8.5.

---

## B. @photon-ai/advanced-imessage 2.2.0

### Entry points (`AIM/index.d.ts`, `AIM/grpc.d.ts`, `AIM/http.d.ts`, `package.json` exports)

| Import | Exports |
|---|---|
| `@photon-ai/advanced-imessage` (root) | `createGrpcClient`, `GrpcAdvancedIMessage`, `GrpcClientOptions`, `createHttpClient`, `AdvancedIMessage` (http), all domain types and error classes |
| `@photon-ai/advanced-imessage/grpc` | `createGrpcClient(options: ClientOptions): AdvancedIMessage`, `createClient` (deprecated alias of `createGrpcClient`), `ClientOptions`, resource interfaces, errors |
| `@photon-ai/advanced-imessage/http` | `createHttpClient` (fetch based, no `events`, no live `subscribeEvents`/`watch` streams) |

The root entry does **not** export `createClient`. Use `createGrpcClient` from `@photon-ai/advanced-imessage/grpc`, exactly as `@spectrum-ts/imessage` does (`IMSG` line 1). The gRPC transport requires the optional peers `nice-grpc`, `nice-grpc-common`, `@grpc/grpc-js`; all three are installed in the pnpm store (pulled in by `@spectrum-ts/imessage`), but `apps/server/package.json` should list them explicitly if the server imports the gRPC entry directly.

### `ClientOptions` (`AIM/grpc.d.ts` lines 15 to 50)

```ts
interface ClientOptions {
  readonly address: string;                 // "host:port", no scheme
  readonly autoIdempotency?: boolean;       // adds x-idempotency-key to mutating RPCs
  readonly channelOptions?: ChannelOptions; // @grpc/grpc-js channel options, e.g. keepalive
  readonly onHeartbeat?: HeartbeatHandler;  // () => void, fired per server heartbeat (~30 s) on any watch/subscribeEvents stream
  readonly retry?: boolean | RetryOptions;  // { initialDelay?, maxAttempts?, maxDelay? }
  readonly timeout?: number;                // ms, unary RPCs only
  readonly tls?: boolean;                   // default true
  readonly token: string | (() => Promise<string>);
}
```

`token` as an async function is confirmed. Use `onHeartbeat` to drive the stall watchdog the spec describes (heartbeats are otherwise dropped silently).

### Namespaces used by Batman (`AIM/grpc.d.ts`)

```ts
interface LocationsResource {
  get(address: string): Promise<SharedFriendLocation>;
  list(): Promise<SharedFriendLocation[]>;
  request(chat: string, address: string, options?: IdempotencyOptions): Promise<LocationRequestReceipt>;
  watch(address?: string): TypedEventStream<SharedFriendLocationUpdated>;
}
interface AddressesResource {
  get(address: string): Promise<MultiServiceAddressInfo>;
  isFocusSilenced(address: string): Promise<boolean>;
  isIMessageAvailable(address: string): Promise<boolean>;
}
interface MessagesResource {
  notifySilenced(chat: string, message: string, options?: { readonly clientMessageId?: string }): Promise<void>;
  listInChat(chat: string, options?: MessageListFilter): Promise<MessageListPage>;
  sendText(chat: string, text: string, options?: SendOptions): Promise<Message>;
  sendAttachment(chat: string, attachment: string, options?: { clientMessageId?; effect?; isAudioMessage?: boolean; replyTo? }): Promise<Message>;
  get(message: string): Promise<Message>;
  // edit, unsend, setReaction, placeSticker, sendMultipart, listRecent, getEmbeddedMedia, subscribeEvents, mini app methods
}
interface ChatsResource {
  create(addresses: string[], options?: CreateChatOptions): Promise<CreateChatResult>;  // { chat: Chat; initialMessage?: Message }
  get(chat: string): Promise<Chat>; markRead(chat: string): Promise<void>; setTyping(chat: string, isTyping: boolean): Promise<void>;
  shareContactInfo(chat: string): Promise<void>; subscribeEvents(filter?): TypedEventStream<ChatEvent>; ...
}
interface AdvancedIMessage extends AsyncDisposable { addresses; attachments; chats; events; groups; locations; messages; polls; close(): Promise<void>; }
```

- `IdempotencyOptions = { readonly clientMessageId?: string }` (groups d.ts line 946). Spec usage `request(chatGuid, address, { clientMessageId })` is correct.
- `MessageListFilter = { after?: Date; before?: Date; isFromMe?: boolean; isRead?: boolean; pageSize?: number (1..100); pageToken?: string }`; `MessageListPage = { messages: readonly Message[]; nextPageToken?: string }` (groups d.ts 557 to 575). Spec usage `listInChat(chatGuid, { pageSize: 5, isFromMe: true })` is correct.
- `Chat.guid` shapes: DM `any;-;{recipient}`, group `any;+;{group-id}` (docs llms-full.txt 7630 to 7640). `@spectrum-ts/imessage` builds the DM GUID locally with `dmChatGuid = (address) => "any;-;" + address` (`IMSG` line 692), so in shared mode the spec can skip `chats.create` and use the space id directly.
- `TypedEventStream`: `for await`, `.on()`, `.filter()`, `.map()`, `.take()`, `.close()`, `Symbol.asyncDispose`; one consumer per stream; breaking out of `for await` closes it.

### Location shape (`AIM/groups-BYjWoH6H.d.ts` lines 836 to 858)

```ts
interface SharedFriendLocation {
  readonly accuracy?: number;        // metres
  readonly address: string;          // normalised email or E.164
  readonly expiresAt?: Date;
  readonly isLocatingInProgress: boolean;
  readonly latitude?: number;
  readonly locationTimestamp?: Date;
  readonly locationType: "legacy" | "live" | "shallow" | "unknown";
  readonly longAddress?: string; readonly longitude?: number; readonly name?: string; readonly shortAddress?: string;
}
interface SharedFriendLocationUpdated { readonly location: SharedFriendLocation; readonly sourceSequence: number; }
interface LocationRequestReceipt { readonly address: string; readonly messageGuid?: string; readonly reason?: string; readonly status: string; }
```

All fields the spec relies on exist: `latitude`, `longitude`, `accuracy`, `locationType`, `expiresAt`, `sourceSequence`. `locationTimestamp` is the fix time (spec `Fix.at` should prefer it over receive time). Docs confirm `get()` throws `NotFoundError` when the share is not visible, `request()` only sends the card, and `watch()` updates are not replayed by `events.catchUp()` (llms-full.txt 9560 to 9760).

### Error classes (`AIM/groups-BYjWoH6H.d.ts` lines 1 to 140)

```ts
declare class IMessageError extends Error { readonly code: ErrorCode; readonly retryable: boolean; readonly grpcCode: number; readonly context: Record<string,string>; readonly retryAfter?: number; readonly source?: string; readonly requestId?: string; }
declare class AuthenticationError extends IMessageError {}  // UNAUTHENTICATED, PERMISSION_DENIED
declare class NotFoundError extends IMessageError {}        // NOT_FOUND
declare class RateLimitError extends IMessageError {}       // RESOURCE_EXHAUSTED
declare class ValidationError extends IMessageError {}      // INVALID_ARGUMENT, FAILED_PRECONDITION
declare class ConnectionError extends IMessageError {}      // UNAVAILABLE, DEADLINE_EXCEEDED
```

`ErrorCode` includes `sharedFriendLocationNotFound`, `addressNotFound`, `chatNotFound`, `messageNotFound`, `tokenExpired`, `tokenBlocked`, `dailyLimitExceeded`, `recipientLimitExceeded`, `newContactThrottled`, `burstRateExceeded`, `duplicateMessage`, `privateApiUnavailable`, `serviceUnavailable`, `timeout`, `networkError`, and others. Branch on `error.retryable` for retry decisions, as the spec says.

---

## C. Spectrum management API (OpenAPI, https://spectrum.photon.codes/openapi/json)

Base `https://spectrum.photon.codes`, `Authorization: Basic base64(projectId:projectSecret)`, envelope `{ succeed: true, data }`. `projectId` path params are UUIDs.

| Method and path (exact, trailing slashes matter) | Request | `data` on 200 |
|---|---|---|
| `POST /projects/{projectId}/imessage/tokens` | none | `{ type: "dedicated", auth: Record<instanceId, token>, numbers: Record<instanceId, phone>, expiresIn: integer seconds }` **or** `{ type: "shared", token: string, expiresIn: integer }` |
| `GET /projects/{projectId}/imessage/` | none | `{ type: "shared" \| "dedicated" }` |
| `GET /projects/{projectId}/imessage/shared/availability?phoneNumber=E164` | query required | `{ available: boolean }` (can a shared number be assigned to this phone) |
| `POST /projects/{projectId}/users/` | JSON `{ type: "shared", phoneNumber: E164, firstName?, lastName?, email? }` or `{ type: "dedicated", phoneNumber: E164, assignedPhoneNumber: E164, firstName?, lastName?, email? }` | `{ id, projectId, type, firstName, lastName, email, phoneNumber, assignedPhoneNumber, meta, createdAt }` |
| `GET /projects/{projectId}/users/` | query `type?`, `id?` (repeatable), `search?`, `limit?` (max 500), `offset?` | `{ users: [...], total }` |
| `GET /projects/{projectId}/users/{userId}/` | none | same user object |
| `DELETE /projects/{projectId}/users/{userId}/` | none | soft delete |
| `GET /users/{userId}/redirect?msg=` | public, no auth; `msg` optional (1 to 1000 chars) | `302` with `Location` header (sms: deep link); `403`, `404`, `422` possible |
| `GET /projects/{projectId}/lines/?platform=imessage` | | `{ lines: [{ platform, id, phoneNumber, profile, status: "available"\|"unavailable"\|"unknown", createdAt }] }` dedicated lines only |
| `GET /projects/{projectId}/lines/route` | | best dedicated iMessage line for a new user; 404 when none |
| `POST /projects/{projectId}/voice/tokens` | none | `{ token, expiresIn }` (a voice LightAuth token; purpose for SIP not documented in Stable, see open questions) |
| `GET/PATCH/DELETE /projects/{projectId}/voice/sip-inbound/` | `{ sipUri: "sip:..."/"sips:...", username?, password? }` | inbound SIP routing config for calls arriving at the line |

Notes from the operation descriptions:

- Creating a shared user is idempotent on `phoneNumber`: re-posting an active number returns the same user and updates optional fields. The server enforces `maxSharedUsers`.
- `assignedPhoneNumber` is the pool number that will text this user. For shared projects it is always returned.
- Dedicated users require `assignedPhoneNumber` to match a line the project owns.
- The redirect endpoint is unauthenticated and is the thing to put in onboarding links.

Core SDK confirms the same endpoints (`CORE` 6117 to 6125, core `dist/index.js` 2918 to 2938: `/projects/${id}/`, `/projects/${id}/imessage/tokens`, `/projects/${id}/imessage/`, `/projects/${id}/platforms/`, `/projects/${id}/billing/subscription`).

---

## D. LiveKit

### livekit-server-sdk 2.19.1 (`LKS/SipClient.d.ts`, `LKS/RoomServiceClient.d.ts`, `LKS/AccessToken.d.ts`, `LKS/LiveKitAPI.d.ts`)

```ts
class SipClient extends ServiceBase {
  constructor(host: string, apiKey?: string, secret?: string, options?: ClientOptions);   // host like "https://<project>.livekit.cloud"; env LIVEKIT_API_KEY / LIVEKIT_API_SECRET
  createSipOutboundTrunk(name: string, address: string, numbers: string[], opts?: CreateSipOutboundTrunkOptions): Promise<SIPOutboundTrunkInfo>;
  listSipOutboundTrunk(list?: ListSipTrunkOptions): Promise<SIPOutboundTrunkInfo[]>;
  updateSipOutboundTrunkFields(sipTrunkId: string, fields: SipOutboundTrunkUpdateOptions): Promise<SIPOutboundTrunkInfo>;
  deleteSipTrunk(sipTrunkId: string): Promise<SIPTrunkInfo>;
  createSipParticipant(sipTrunkId: string, number: string, roomName: string, opts?: CreateSipParticipantOptions, outboundTrunkConfig?: SIPOutboundConfig): Promise<SIPParticipantInfo>;
  transferSipParticipant(roomName: string, participantIdentity: string, transferTo: string, opts?): Promise<void>;
  createSipTrunk(...)  // deprecated
}
interface CreateSipOutboundTrunkOptions {
  metadata?: string;
  transport: SIPTransport;            // required in the type
  destinationCountry?: string;
  authUsername?: string; authPassword?: string;   // snake_case auth_username/auth_password are deprecated aliases
  headers?: Record<string,string>; headersToAttributes?: Record<string,string>; includeHeaders?: SIPHeaderOptions;
  media?: SIPMediaConfig;             // mediaEncryption deprecated
}
interface CreateSipParticipantOptions {
  fromNumber?: string; participantIdentity?: string; participantName?: string; displayName?: string;
  participantMetadata?: string; participantAttributes?: Record<string,string>;
  dtmf?: string; playDialtone?: boolean;  // playRingtone deprecated
  headers?: Record<string,string>; includeHeaders?: SIPHeaderOptions; hidePhoneNumber?: boolean;
  ringingTimeout?: number;   // seconds, upper limit 80 per docs
  maxCallDuration?: number;  // seconds
  krispEnabled?: boolean;
  waitUntilAnswered?: boolean;
  timeout?: number;          // seconds; defaults to 30 when waitUntilAnswered is true
  media?: SIPMediaConfig;
}
```

- `SIPTransport` comes from `@livekit/protocol` (`dist/index.d.ts` line 17076): `SIP_TRANSPORT_AUTO = 0`, `SIP_TRANSPORT_UDP = 1`, `SIP_TRANSPORT_TCP = 2`, `SIP_TRANSPORT_TLS = 3`. LiveKit's SIP API reference lists TLS as a valid outbound transport (https://docs.livekit.io/reference/telephony/sip-api.md, SIPTransport table). So the spec's preference order is achievable: trunk `address = "sip.spectrum.photon.codes:5061"`, `transport: SIPTransport.SIP_TRANSPORT_TLS`, fallback `address = "sip.spectrum.photon.codes:5060"`, `transport: SIPTransport.SIP_TRANSPORT_TCP`. `@livekit/protocol` is a dependency of `livekit-server-sdk` but should be added to `apps/server/package.json` to import the enum.
- Photon side (Stable docs, https://photon.codes/docs/spectrum-ts/providers/voice/outbound-calls.md): server `sip.spectrum.photon.codes`, TLS/5061 preferred, TCP/5060 supported, UDP not supported, username = project ID, password = project secret, registration off, caller ID must be an iMessage line owned by the project, RTP is UDP and unencrypted. Matches spec 10.1.
- Inline trunk alternative (docs https://docs.livekit.io/telephony/making-calls/outbound-calls.md): `new SIPOutboundConfig({ hostname, transport, authUsername, authPassword, destinationCountry })` from `@livekit/protocol` as the 5th argument with `sipTrunkId = ""` and `fromNumber` set. `SIPOutboundConfig` fields: `hostname`, `destinationCountry`, `transport`, `authUsername`, `authPassword`, `headersToAttributes`, `attributesToHeaders`, `fromHost`.
- `LiveKitAPI` wrapper also exists: `new LiveKitAPI({ host, apiKey, secret })` with getters `.room` (RoomServiceClient) and `.sip` (SipClient). Errors: `SipCallError`, `TwirpError`, `ServerError` exported from the root.

```ts
class RoomServiceClient extends ServiceBase {
  constructor(host: string, apiKey?: string, secret?: string, options?: ClientOptions);
  createRoom(options: CreateOptions): Promise<Room>;   // CreateOptions { name: string; emptyTimeout?: number; departureTimeout?: number; maxParticipants?: number; metadata?: string; egress?; minPlayoutDelay?; maxPlayoutDelay?; syncStreams?; agents?; nodeId? }
  deleteRoom(room: string): Promise<void>; listParticipants(room); removeParticipant(room, identity); ...
}
class AccessToken {
  constructor(apiKey?: string, apiSecret?: string, options?: AccessTokenOptions);  // { ttl?: number | string; name?: string; identity?: string; metadata?; attributes? }
  addGrant(grant: VideoGrant): void;   // { roomJoin?: boolean; room?: string; canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean; canPublishSources?: TrackSource[]; ... }
  toJwt(): Promise<string>;
}
```

### @livekit/rtc-node 1.1.0 (`RTC/*.d.ts`)

```ts
class Room {
  localParticipant?: LocalParticipant;
  connect(url: string, token: string, opts?: RoomOptions): Promise<void>;  // RoomOptions { autoSubscribe: boolean; dynacast: boolean; e2ee?; rtcConfig? }
  disconnect(): Promise<void>;
}
class AudioSource {
  constructor(sampleRate: number, numChannels: number, queueSize?: number);
  sampleRate: number; numChannels: number; queueSize: number;
  get queuedDuration(): number; clearQueue(): void; waitForPlayout(): Promise<void>;
  captureFrame(frame: AudioFrame): Promise<void>;
  close(): Promise<void>;
}
class AudioFrame {
  constructor(data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number, userdata?: Record<string, unknown>);
  static create(sampleRate: number, channels: number, samplesPerChannel: number, userdata?): AudioFrame;
  data: Int16Array; sampleRate: number; channels: number; samplesPerChannel: number;
}
class LocalAudioTrack extends Track { static createAudioTrack(name: string, source: AudioSource): LocalAudioTrack; }
class LocalParticipant extends Participant {
  publishTrack(track: LocalTrack, options: TrackPublishOptions): Promise<LocalTrackPublication>;
  unpublishTrack(trackSid: string, stopOnUnpublish?: boolean): Promise<void>;
}
class AudioResampler { constructor(inputRate: number, outputRate: number, channels?: number, quality?: AudioResamplerQuality); push(...); flush(); }
export function dispose(): Promise<void>;  // ffi shutdown
```

- `TrackPublishOptions` and `TrackSource` are re-exported from `@livekit/rtc-ffi-bindings` (`RTC/index.d.ts`). `TrackPublishOptions` fields: `source?: TrackSource`, `dtx?`, `red?`, `simulcast?`, `audioEncoding?`, `videoCodec?`, `stream?`, `preconnectBuffer?`. `TrackSource.SOURCE_MICROPHONE = 2`. Publish with `new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE })`.
- Publishing pattern: `const source = new AudioSource(24000, 1); const track = LocalAudioTrack.createAudioTrack("tts", source); await room.localParticipant.publishTrack(track, opts); for (const frame of frames) await source.captureFrame(frame); await source.waitForPlayout();`. Frame data is interleaved signed 16-bit PCM; `samplesPerChannel = data.length / channels`. 10 ms or 20 ms frames are typical. OpenAI `pcm` output is 24 kHz mono 16-bit, so `AudioSource(24000, 1)` needs no resample; LiveKit resamples to G.711 8 kHz for the SIP leg server side.
- Windows: `@livekit/rtc-ffi-bindings-win32-x64-msvc@0.12.73` is present in the pnpm store (`C:\Users\yalam\batman\node_modules\.pnpm\@livekit+rtc-ffi-bindings-win32-x64-msvc@0.12.73`), so the native binary installed on this machine. `engines.node >= 18`. Call `dispose()` on shutdown or the process may hang on the ffi thread. Runtime connectivity still needs Spike S2.

---

## E. Anthropic SDK 0.133.0 (`ANTH/resources/messages/messages.d.ts`, `ANTH/lib/parser.d.ts`, `ANTH/helpers/zod.d.ts`, `ANTH/core/error.d.ts`, `ANTH/internal/request-options.d.ts`)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";   // zod v4, matches project zod 4.6.5

class Messages {
  create(params: MessageCreateParamsNonStreaming, options?: RequestOptions): APIPromise<Message>;
  create(params: MessageCreateParamsStreaming, options?: RequestOptions): APIPromise<Stream<RawMessageStreamEvent>>;
  parse<Params extends MessageCreateParamsNonStreaming>(params: Params, options?: RequestOptions): APIPromise<ParsedMessage<ExtractParsedContentFromParams<Params>>>;
  stream<Params extends MessageStreamParams>(body: Params, options?: RequestOptions): MessageStream<...>;
  countTokens(params, options?): APIPromise<MessageTokensCount>;
}
```

- `output_config` exists: `MessageCreateParamsBase.output_config?: OutputConfig` (messages.d.ts line 5297; also on `MessageCountTokensParams` line 5585).
- Exact type path: `import type { OutputConfig, JSONOutputFormat } from "@anthropic-ai/sdk/resources/messages/messages"` (also reachable as `Anthropic.Messages.OutputConfig`).

```ts
export interface OutputConfig {
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  format?: JSONOutputFormat | null;
}
export interface JSONOutputFormat { schema: { [key: string]: unknown }; type: 'json_schema'; }
// lib/parser.d.ts
type AutoParseableOutputFormat<ParsedT> = JSONOutputFormat & { parse(content: string): ParsedT };
type ParsedMessage<ParsedT> = Message & { content: Array<ParsedContentBlock<ParsedT>>; parsed_output: ParsedT | null };
// helpers/zod.d.ts
function zodOutputFormat<ZodInput extends z.ZodType>(zodObject: ZodInput): AutoParseableOutputFormat<z.infer<ZodInput>>;
```

- `client.messages.parse({ model, max_tokens, messages, output_config: { format: zodOutputFormat(PlanExtraction) } })` returns `message.parsed_output` typed from the zod schema. With `create()` and a raw `{ type: "json_schema", schema }` you parse the text block yourself.
- Models: `type Model = 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-fable-5-1' | 'claude-opus-5-5' | ... | (string & {})` (line 3583). Both `claude-opus-5-5` and `claude-haiku-5-5` are in the installed union.
- Timeout: `RequestOptions.timeout?: number` is **milliseconds** (`internal/request-options.d.ts` line 82, "@unit milliseconds"); `ClientOptions.timeout` default 10 minutes, `maxRetries` default 2 (retries count against wall clock, so a 6 s budget needs `{ timeout: 6000, maxRetries: 0 }` or an outer `AbortSignal`).
- Errors (`core/error.d.ts`, all re-exported from the root): `AnthropicError`, `APIError` (status, headers, error), `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError`, `RetryableError`, `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableEntityError` (422), `RateLimitError` (429), `InternalServerError` (>=500).
- Model behaviour notes from the claude-api skill (not from the `.d.ts`): on `claude-opus-5-5` thinking cannot be disabled and `output_config.effort` defaults to `medium`; set `effort: "low"` for the classifier path to fit the 6 s budget; forced `tool_choice` `any`/`tool` returns 400, so use `output_config.format` for structured output (as the spec already does); check `stop_reason === "refusal"` before reading content. `claude-haiku-5-5` has the same adaptive-thinking default.

---

## F. OpenAI SDK 7.32.0 (`OAI/resources/audio/*.d.ts`, `OAI/internal/uploads.d.ts`, `OAI/internal/to-file.d.ts`, `OAI/core/error.d.ts`)

### STT

```ts
class Transcriptions {
  create(body: TranscriptionCreateParamsNonStreaming<'json' | undefined>, options?: RequestOptions): APIPromise<Transcription>;
  create(body: TranscriptionCreateParamsNonStreaming<'verbose_json'>, options?): APIPromise<TranscriptionVerbose>;
  create(body: TranscriptionCreateParamsNonStreaming<'srt' | 'vtt' | 'text'>, options?): APIPromise<string>;
  create(body: TranscriptionCreateParamsStreaming, options?): APIPromise<Stream<TranscriptionStreamEvent>>;
}
interface TranscriptionCreateParamsBase<ResponseFormat> {
  file: Uploadable;
  model: (string & {}) | AudioModel;   // 'whisper-1' | 'gpt-transcribe' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'gpt-4o-mini-transcribe-2025-12-15' | 'gpt-4o-transcribe-diarize'
  language?: string; prompt?: string; response_format?: ResponseFormat; temperature?: number; include?: ...; timestamp_granularities?: ...; chunking_strategy?: ...; known_speaker_names?; known_speaker_references?;
}
interface Transcription { text: string; languages?: ...; logprobs?: ...; usage?: ... }
type Uploadable = File | Response | FsReadStream | BunFile | NamedBlob | AsyncIterable<BlobPart> | ReadableStream<BlobPart> | StreamingFile;
function toFile(value: ToFileInput | PromiseLike<ToFileInput>, name?: string | null, options?: FilePropertyBag): Promise<File>;   // exported from "openai" root and "openai/uploads"
```

- For a `Buffer` from `content.read()`: `await client.audio.transcriptions.create({ file: await toFile(buffer, "note.m4a", { type: "audio/mp4" }), model: env.STT_MODEL })`. The file name extension is what the API uses to sniff the container, so name it correctly after any ffmpeg conversion.
- For `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` the only supported `response_format` is `json` (doc comment, transcriptions.d.ts lines 605 to 607). Streaming is ignored for `whisper-1`.

### TTS

```ts
class Speech { create(body: SpeechCreateParams, options?: RequestOptions): APIPromise<Response>; }
type SpeechModel = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts' | 'gpt-4o-mini-tts-2025-12-15';
interface SpeechCreateParams {
  input: string;                               // max 4096 chars
  model: (string & {}) | SpeechModel;
  voice: string | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar' | 'fable' | 'onyx' | 'nova' | { id: string };
  instructions?: string;                       // not for tts-1 / tts-1-hd
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;                              // 0.25 to 4.0
  stream_format?: 'sse' | 'audio';
}
```

- Getting a Buffer: `const res = await client.audio.speech.create({...}); const buf = Buffer.from(await res.arrayBuffer());` (`APIPromise<Response>` is a fetch `Response`; `.blob()`, `.arrayBuffer()`, `.body` all work).
- For LiveKit frames use `response_format: "pcm"` (raw 16-bit LE mono; OpenAI documents 24 kHz, not verifiable from types) and wrap in `AudioFrame`.
- For iMessage voice notes: `response_format: "aac"` yields raw ADTS AAC, which `ensureM4a` will **not** transcode (`audio/aac` is in its M4A MIME allow list) and which may not be a playable iMessage voice note. Safer: `wav` or `pcm` then ffmpeg to `.m4a` (`-c:a aac`), send with `mimeType: "audio/mp4"`. See open questions.
- Errors (`core/error.d.ts`): `OpenAIError`, `APIError`, `APIConnectionError`, `APIConnectionTimeoutError`, `APIUserAbortError`, `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, `RateLimitError`, `InternalServerError`, `LengthFinishReasonError`, `ContentFilterFinishReasonError`. `ClientOptions.timeout` and `RequestOptions.timeout` are milliseconds; `maxRetries` default 2.

---

## Mismatches with spec

1. **11.3 `createClient({ address, token })`:** the root entry of `@photon-ai/advanced-imessage@2.2.0` exports `createGrpcClient` and `createHttpClient`, not `createClient`. `createClient` exists only on the `/grpc` subpath as a deprecated alias. Use `import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc"`. The HTTP client lacks `events`, `subscribeEvents` and `locations.watch`, so gRPC is required for Find My streaming.
2. **11.3 gRPC address (open in spec):** resolved above. Shared pool: `imessage.spectrum.photon.codes:443` (env override `SPECTRUM_IMESSAGE_ADDRESS`). Dedicated: `{instanceId}.imsg.photon.codes:443`. Always `tls: true`.
3. **11.1 trailing slashes:** the users endpoint is `POST /projects/{id}/users/` (trailing slash; the spec writes `/users`). `GET /projects/{id}/imessage/` has a trailing slash (spec correct). `/imessage/tokens` and `/users/{userId}/redirect` have none. Spectrum's own webhook docs say redirects are not followed, so send the exact path.
4. **11.1 redirect response:** `GET /users/{userId}/redirect` is a public `302` with the `sms:` link in the `Location` header, not a JSON body. Fetch with `redirect: "manual"` and read `Location`, or hand the URL itself to the user.
5. **11.1 Spike S5 is already answered by Stable docs:** on Free/Pro a shared line can only message numbers registered as project users; others fail with `Target not allowed for this project`. Guardian registration via `POST /projects/{id}/users/` is mandatory before the first L3 alert, and it counts toward `maxSharedUsers`. `GET /projects/{id}/imessage/shared/availability?phoneNumber=` can pre-check assignability.
6. **11.2 `options.logLevel`:** type is `"debug" | "info" | "warn" | "error" | "silent"`, so `env.LOG_LEVEL` must be validated before passing; pino's `trace`/`fatal` will fail type checking.
7. **8.4 content union:** besides the seven types the spec lists, `app.messages` can deliver `markdown`, `richlink`, `group`, `app`, `poll`, `reply`, `edit`, `unsend`, `effect`, `streamText`, `custom`, `typing`, `rename`, `avatar`, `addMember`, `removeMember`, `leaveSpace`. The default branch must be a silent ignore, and `group` items (one message with several parts) should be unpacked or `options.flattenGroups: true` set.
8. **8.4 voice note input format:** inbound iMessage voice notes surface as `audio/x-caf`. OpenAI transcription does not list CAF among supported inputs, so ffmpeg conversion is not optional; make `ffmpeg-static` a hard dependency (it also unlocks `ensureM4a` for outbound notes that are not already m4a).
9. **8.4 message ids:** a captioned attachment arrives as multiple `Message`s (part 0 has the GUID, later parts have derived child ids and `parentId`). Dedupe on `message.id` still works but reaction matching should target the GUID of the first part of the check-in message Batman sent.
10. **9.5 TTS to iMessage:** `response_format: "aac"` from OpenAI is raw ADTS and bypasses `ensureM4a` transcoding (the MIME allow list includes `audio/aac`). Produce `wav`/`pcm` and transcode to `.m4a` with ffmpeg yourself, then `voice(buffer, { name: "note.m4a", mimeType: "audio/mp4", duration })`.
11. **10.2 LiveKit method names:** the current method is `createSipOutboundTrunk(name, address, numbers, { transport, authUsername, authPassword })` (not `createSipTrunk`, which is deprecated). `transport` is typed as required. TLS is supported (`SIPTransport.SIP_TRANSPORT_TLS = 3`), so the spec's "prefer TLS/5061 if supported" resolves to: use TLS and `sip.spectrum.photon.codes:5061`. `createSipParticipant(sipTrunkId, number, roomName, opts?, outboundTrunkConfig?)` exists as the spec assumes; `waitUntilAnswered`, `ringingTimeout`, `maxCallDuration`, `playDialtone` are available for the call scripts.
12. **9.2 LLM provider:** the spec text says "Use the OpenAI API with a JSON schema", while this project is using Anthropic for extraction/classification and OpenAI only for STT/TTS. The Anthropic path is `client.messages.parse` with `output_config.format = zodOutputFormat(schema)`; keep the `LlmProvider` interface the spec already allows.
13. **11.2 terminal provider "configurable address":** `terminal.config()` only accepts `commands`. There is no option to set the fake user's address; the sender id is whatever the terminal child process assigns. Map terminal sender ids to a configured E.164 inside Batman's `Channel` adapter instead.
14. **11.4 `im.chats.create([address])` in shared mode:** unnecessary for DMs; the DM GUID is deterministic (`any;-;{address}`) and `@spectrum-ts/imessage` builds it locally. Still valid to call, but it is a network round trip you can skip.
15. **7.1 heartbeat:** the SDK offers `ClientOptions.onHeartbeat` (server heartbeat about every 30 s on `watch` streams). Use it alongside the 60 s `get()` heartbeat the spec already specifies; it detects half-open streams sooner.

## Open questions

1. **Does the shared-pool token authorise `locations.*`, `addresses.*` and `messages.notifySilenced` against `imessage.spectrum.photon.codes:443`?** The address and token plumbing is confirmed, but whether the shared proxy exposes Find My and Focus RPCs for Free/Pro projects (or returns `privateApiUnavailable` / `operationNotSupported`) is not stated in Stable docs. This is the real Spike S1.
2. **Whose Find My account is the "current iMessage account" on a shared line?** Shared lines serve many projects; `locations.list()` returns shares visible to the line's account. Whether a user's share to a pool number is visible to our project, and whether a different pool number is used for different recipients, needs live testing.
3. **Is `POST /projects/{id}/voice/tokens` needed for SIP?** The OpenAPI exposes a voice LightAuth token, but the Stable voice docs authenticate SIP with projectId:projectSecret only. Unknown whether Free/Pro projects can place outbound calls at all (docs require "an iMessage line in that project", which a shared-pool project does not own). This decides Spike S2 and whether `VoiceNoteFallback` is the primary path.
4. **Caller ID on shared pool:** the From number must be "an iMessage line owned by the project". A shared-pool project has only `assignedPhoneNumber` per user; whether that counts is unverified.
5. **OpenAI accepted audio containers and `pcm` sample rate:** not verifiable from the installed types; platform.openai.com could not be fetched as text. Treat "pcm = 24 kHz, 16-bit, mono" and "CAF not accepted" as documentation knowledge to confirm during Spike S3.
6. **Whether iMessage accepts raw ADTS `.aac` as an audio message:** untested; the safe path is an m4a container.
7. **LiveKit Cloud SIP egress to Spectrum over TLS:** certificate verification against `sip.spectrum.photon.codes` must succeed from LiveKit's SIP service; if it does not, fall back to TCP/5060 as the spec allows.
8. **`@livekit/rtc-node` runtime on Windows:** RESOLVED 2026-10-10 by Spike S2 `room` step: a bot joined a LiveKit room from Windows and published a 48 kHz mono track; 2000 ms of audio streamed in 2001 ms.

## Addendum 2026-10-10 (from Spikes S5 and S6, live)
- Sending to a Photon pool number fails with `ValidationError`, gRPC 3 INVALID_ARGUMENT, `retryable=false`: "Target is a Photon-managed shared line, not a valid recipient. Send to the user's own number, not the assigned line." Two shared-pool projects therefore cannot text each other. The probe-line E2E (spec 16.3) is not possible on Free/Pro.
- Every registration returns a pool number per user, and they differ across users. A guardian sees a different Batman number than the user. Alert copy must never say "this number" as if shared.
- `GET /imessage/shared/availability` returned `available: true` for a pool number, so it cannot detect pool numbers.
- Never retry the ValidationError above.

## Addendum 2026-10-10 (from Spike S1, observed against the live shared-pool project)
- Shared token: `POST /projects/{id}/imessage/tokens` returned `type: "shared"`, `expiresIn: 900` (15 min). Refresh at 80% (12 min).
- Every gRPC call that targets the human's registered number (`addresses.isIMessageAvailable`, `addresses.isFocusSilenced`, `addresses.get`, `chats.get`, `messages.listInChat`, `locations.request`, `locations.get`) failed with `AuthenticationError`, gRPC code 7 PERMISSION_DENIED, `retryable=false`, message `[spectrum-imessage] Target not allowed for this project`, even though `GET /projects/{id}/users/` lists the number as a registered shared user. Photon troubleshooting names two causes: the number is not a registered user (ruled out), or the Apple iMessage handle differs from the registered number (to check on the iPhone via https://debug.photon.codes). It may also require the user to text the assigned line first. Unresolved; see docs/spikes/S1.md.
- `locations.list()` on a shared token fails with gRPC 9 FAILED_PRECONDITION `No instance routed for this request`. There is no target to route by. Batman must never call `list()`; acceptance is detected with `get(address)` (spec 7.1). Invariant I2 then holds by construction.

## Addendum 2026-10-10 (from the gateway build, verified against installed @spectrum-ts/imessage 12.10.1 source)
- Contact card sharing: `imessage(space).shareContactCard()` exists and works on the shared pool (needs a type cast).
- Message ids: the SDK passes the message id through unchanged as the iMessage id. On the shared pool the `spc-msg-<uuid>` id is what gRPC expects, so `messages.notifySilenced("any;-;<number>", id)` takes it directly; strip a `p:<i>/` prefix for parts of multi-part messages.
- Multi-part inbound messages arrive as ONE message with content type `group` whose parts are inside it (not separate messages).
- Reactions: only added reactions are delivered; removals are not.

## Addendum 2026-10-10 (read receipts, verified against installed types)
- `@photon-ai/advanced-imessage` 2.2.0 `dist/grpc.d.ts` `ChatsResource.markRead(chat: string): Promise<void>` marks every unread message in the chat as read. There is no per-message API. DM chat GUID: `any;-;<E164>`.
- `@spectrum-ts/imessage` 12.10.1 uses the same call internally (`remote.chats.markRead(toChatGuid(spaceId))`, sent when a `read` content is sent to a space) and drops the echo of its own markRead (the resolved target is an inbound message).
- Batman calls it fire and forget from the gateway (`gateway/readReceipts.ts`, InboundLoop `onAccepted`, after dedupe). Users have always texted first, so the shared-pool allowlist permits it. Not yet observed live.
