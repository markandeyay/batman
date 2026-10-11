// advanced-imessage client factory with token refresh (spec 11.3; PHOTON_NOTES "Headline finding").
//
// createGrpcClient comes from "@photon-ai/advanced-imessage/grpc" (the root entry has no
// createClient). Shared pool: address IMESSAGE_GRPC_ADDRESS (imessage.spectrum.photon.codes:443),
// bearer = data.token. Dedicated: {instanceId}.imsg.photon.codes:443 per data.auth key.
// Tokens come from POST /projects/{id}/imessage/tokens (Basic auth) and are re-minted at 80%
// of expiresIn (900 s observed, so every 12 min). The token is never logged.
//
// Never call locations.list() on a shared token (FAILED_PRECONDITION; I2 holds by construction).
import { createGrpcClient, type AdvancedIMessage, type ClientOptions } from "@photon-ai/advanced-imessage/grpc";
import { z } from "zod";

export type { AdvancedIMessage };

export const SPECTRUM_API = "https://spectrum.photon.codes";

const sharedToken = z.object({ type: z.literal("shared"), token: z.string().min(1), expiresIn: z.number().int().positive() });
const dedicatedToken = z.object({
  type: z.literal("dedicated"),
  auth: z.record(z.string(), z.string().min(1)).refine((a) => Object.keys(a).length > 0, "no instances"),
  numbers: z.record(z.string(), z.string()).default({}),
  expiresIn: z.number().int().positive(),
});
export const TokenDataSchema = z.discriminatedUnion("type", [sharedToken, dedicatedToken]);
export const TokenResponseSchema = z.object({ succeed: z.boolean().optional(), data: TokenDataSchema });
export type TokenData = z.infer<typeof TokenDataSchema>;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export async function mintImessageToken(projectId: string, projectSecret: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<TokenData> {
  const auth = "Basic " + Buffer.from(`${projectId}:${projectSecret}`).toString("base64");
  const r = await fetchFn(`${SPECTRUM_API}/projects/${encodeURIComponent(projectId)}/imessage/tokens`, {
    method: "POST",
    headers: { authorization: auth },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) throw new Error(`POST /imessage/tokens -> HTTP ${r.status}`);
  const parsed = TokenResponseSchema.safeParse(await r.json());
  if (!parsed.success) throw new Error("POST /imessage/tokens: unexpected response shape");
  return parsed.data.data;
}

/** Holds the current token and re-mints at 80% of expiresIn. Concurrent callers share one mint. */
export class TokenManager {
  private data: TokenData | null = null;
  private mintedAt = 0;
  private inflight: Promise<TokenData> | null = null;

  constructor(
    private readonly mint: () => Promise<TokenData>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Current token data, minting or refreshing when due. */
  async current(): Promise<TokenData> {
    if (this.data && this.now() - this.mintedAt < this.data.expiresIn * 1000 * 0.8) return this.data;
    this.inflight ??= this.mint().then(
      (d) => {
        this.data = d;
        this.mintedAt = this.now();
        this.inflight = null;
        return d;
      },
      (err: unknown) => {
        this.inflight = null;
        throw err;
      },
    );
    return this.inflight;
  }

  /** Bearer for one instance (dedicated) or the shared token. */
  async token(instanceId?: string): Promise<string> {
    const d = await this.current();
    if (d.type === "shared") return d.token;
    const id = instanceId ?? Object.keys(d.auth)[0]!;
    const t = d.auth[id];
    if (!t) throw new Error("dedicated token missing for instance");
    return t;
  }
}

export interface ImessageClientOptions {
  projectId: string;
  projectSecret: string;
  /** env.IMESSAGE_GRPC_ADDRESS, used for shared-pool tokens. */
  sharedAddress: string;
  fetch?: FetchLike;
  /** Injected for tests. */
  createClient?: (o: ClientOptions) => AdvancedIMessage;
  onHeartbeat?: () => void;
  /** Unary RPC timeout, ms. Default 30000. */
  timeoutMs?: number;
  now?: () => number;
}

export interface ImessageClient {
  im: AdvancedIMessage;
  address: string;
  type: TokenData["type"];
  tokens: TokenManager;
  close(): Promise<void>;
}

/**
 * Mint a token, pick the address for the token type, and build the gRPC client. The SDK's own
 * retry is enabled (it honours `retryable`); autoIdempotency adds x-idempotency-key to writes.
 */
export async function createImessageClient(o: ImessageClientOptions): Promise<ImessageClient> {
  const tokens = new TokenManager(() => mintImessageToken(o.projectId, o.projectSecret, o.fetch), o.now);
  const first = await tokens.current();
  let address: string;
  let instanceId: string | undefined;
  if (first.type === "shared") {
    address = o.sharedAddress;
  } else {
    instanceId = Object.keys(first.auth)[0]!;
    address = `${instanceId}.imsg.photon.codes:443`;
  }
  const options: ClientOptions = {
    address,
    autoIdempotency: true,
    retry: true,
    tls: true,
    timeout: o.timeoutMs ?? 30_000,
    token: () => tokens.token(instanceId),
    ...(o.onHeartbeat ? { onHeartbeat: o.onHeartbeat } : {}),
  };
  const im = (o.createClient ?? createGrpcClient)(options);
  return { im, address, type: first.type, tokens, close: () => im.close() };
}

/** DM chat GUID, built locally exactly like @spectrum-ts/imessage dmChatGuid (no chats.create). */
export const dmChatGuid = (address: string): string => `any;-;${address}`;

/** Spectrum ids of group parts look like "p:<i>/<guid>"; the gRPC API wants the parent guid. */
export const toMessageGuid = (spectrumId: string): string => spectrumId.replace(/^p:\d+\//, "");
