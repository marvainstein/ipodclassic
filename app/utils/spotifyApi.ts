import querystring from "query-string";

const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

export class SpotifyApiError extends Error {
  status: number;
  spotifyMessage?: string;

  constructor(status: number, message: string, spotifyMessage?: string) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
    this.spotifyMessage = spotifyMessage;
  }
}

type SpotifyApiOptions = {
  endpoint: string;
  accessToken: string;
  method?: "GET" | "PUT" | "POST" | "DELETE";
  params?: Record<string, any>;
  body?: object;
  onTokenExpired?: () => Promise<string | undefined>;
  /** Abort the request if Spotify hasn't answered within this many ms. */
  timeoutMs?: number;
};

/**
 * Requests without a timeout can hang indefinitely on iOS after the app comes
 * back from the background (dead sockets, network handoff). That leaves the
 * UI stuck in a loading state, so every request gets a deadline.
 */
const DEFAULT_TIMEOUT_MS = 15000;

async function executeRequest<T>(
  url: string,
  accessToken: string,
  method: string,
  body: object | undefined,
  timeoutMs: number
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SpotifyApiError(
        408,
        `Spotify API request timed out after ${timeoutMs}ms`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const spotifyMessage = errorData.error?.message;
    throw new SpotifyApiError(
      response.status,
      `Spotify API error (${response.status}): ${spotifyMessage || response.statusText}`,
      spotifyMessage
    );
  }

  const contentType = response.headers.get("content-type");
  if (
    response.status === 204 ||
    !contentType?.includes("application/json")
  ) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function spotifyApi<T extends object = object>(
  options: SpotifyApiOptions
): Promise<T> {
  const {
    endpoint,
    accessToken,
    method = "GET",
    params = {},
    body,
    onTokenExpired,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const queryParams = querystring.stringify(params);
  const url = queryParams
    ? `${SPOTIFY_API_BASE}/${endpoint}?${queryParams}`
    : `${SPOTIFY_API_BASE}/${endpoint}`;

  try {
    return await executeRequest<T>(url, accessToken, method, body, timeoutMs);
  } catch (error) {
    if (
      error instanceof SpotifyApiError &&
      error.status === 401 &&
      onTokenExpired
    ) {
      const newToken = await onTokenExpired();
      if (newToken) {
        return await executeRequest<T>(url, newToken, method, body, timeoutMs);
      }
    }
    throw error;
  }
}
