import {
  useViewContext,
  useSettings,
  useInterval,
  useEffectOnce,
} from "@/hooks";
import { useState, useRef, useCallback, useEffect, createContext, useMemo } from "react";
import * as SpotifyUtils from "@/utils/spotify";
import { SPOTIFY_TOKENS_COOKIE_NAME } from "@/utils/constants/api";

export interface SpotifySDKState {
  isPlayerConnected: boolean;
  isSdkReady: boolean;
  spotifyPlayer?: Spotify.Player;
  accessToken?: string;
  deviceId?: string;
  hasError: boolean;
  refreshAccessToken: () => Promise<string | undefined>;
  /** Returns a non-expired access token, refreshing it first if needed. */
  getFreshAccessToken: () => Promise<string | undefined>;
  /**
   * Resolves with the id of a connected playback device. If the device went
   * offline (e.g. iOS suspended the app), reconnects and waits for it.
   * Pass `force` when Spotify rejected the current device id.
   */
  ensureDeviceReady: (options?: { force?: boolean }) => Promise<string | undefined>;
}

export const SpotifySDKContext = createContext<SpotifySDKState | undefined>(
  undefined
);
interface Props {
  children: React.ReactNode;
}

/** Spotify access tokens live for 60 minutes; refresh well before that. */
const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;
/** How long to wait for the SDK to report `ready` after (re)connecting. */
const DEVICE_READY_TIMEOUT_MS = 8000;

const getClientCookie = (name: string): string | undefined => {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : undefined;
};

export const SpotifySDKProvider = ({ children }: Props) => {
  const { showPopup, hideView } = useViewContext();
  const { setIsSpotifyAuthorized } = useSettings();
  const [deviceId, setDeviceId] = useState<string>();
  const spotifyPlayerRef = useRef<Spotify.Player | undefined>(undefined);
  const [isPlayerConnected, setIsPlayerConnected] = useState(false);
  const [isSdkReady, setIsSdkReady] = useState(false);
  const [hasError, setHasError] = useState(false);

  /** Latest device id reported by `ready`; cleared on `not_ready`. */
  const deviceIdRef = useRef<string | undefined>(undefined);
  /** Callers waiting for the next `ready` event. */
  const readyWaitersRef = useRef<Array<(id: string | undefined) => void>>([]);
  const reconnectPromiseRef = useRef<Promise<string | undefined> | null>(null);

  const { storedAccessToken, tokenLastRefreshedTimestamp } = useMemo(() => {
    try {
      const cookieValue = getClientCookie(SPOTIFY_TOKENS_COOKIE_NAME);
      if (!cookieValue) return {};
      const parsed = JSON.parse(cookieValue);
      return {
        storedAccessToken: parsed.accessToken as string | undefined,
        tokenLastRefreshedTimestamp: parsed.lastRefreshedTimestamp?.toString() as string | undefined,
      };
    } catch {
      return {};
    }
  }, []);

  const [accessToken, setAccessToken] = useState<string | undefined>(
    storedAccessToken
  );

  // Keep a ref so the Spotify SDK's getOAuthToken callback always reads the latest token
  const accessTokenRef = useRef<string | undefined>(storedAccessToken);
  const tokenRefreshedAtRef = useRef<number>(
    Number(tokenLastRefreshedTimestamp) || 0
  );
  const refreshPromiseRef = useRef<Promise<string | undefined> | null>(null);

  const handleUnsupportedAccountError = useCallback(() => {
    showPopup({
      title: "Unable to sign in",
      description:
        "Spotify requires a Premium account to play music on the web",
      listOptions: [
        {
          type: "action",
          label: "Okay 😞",
          onSelect: hideView,
        },
      ],
    });
  }, [hideView, showPopup]);

  const handleRefreshTokens = useCallback((): Promise<string | undefined> => {
    // Deduplicate: the interval, the SDK, a 401 retry and the
    // visibilitychange handler can all ask for a refresh at the same time.
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    const refresh = (async () => {
      console.log("[spotify] Attempting token refresh…");
      try {
        const { accessToken: updatedAccessToken } =
          await SpotifyUtils.getRefreshedSpotifyTokens();

        if (updatedAccessToken) {
          console.log("[spotify] Token refresh succeeded");
          accessTokenRef.current = updatedAccessToken;
          tokenRefreshedAtRef.current = Date.now();
          setAccessToken(updatedAccessToken);
        } else {
          console.warn("[spotify] Token refresh returned no access token");
        }
        return updatedAccessToken;
      } catch (error) {
        console.error("[spotify] Failed to refresh tokens:", error);
        setHasError(true);
        return undefined;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    refreshPromiseRef.current = refresh;
    return refresh;
  }, []);

  const getFreshAccessToken = useCallback(async () => {
    const age = Date.now() - tokenRefreshedAtRef.current;
    if (!accessTokenRef.current || age > TOKEN_MAX_AGE_MS) {
      return (await handleRefreshTokens()) ?? accessTokenRef.current;
    }
    return accessTokenRef.current;
  }, [handleRefreshTokens]);

  const resolveReadyWaiters = useCallback((id: string | undefined) => {
    const waiters = readyWaitersRef.current;
    readyWaitersRef.current = [];
    waiters.forEach((resolve) => resolve(id));
  }, []);

  const waitForReady = useCallback(
    () =>
      new Promise<string | undefined>((resolve) => {
        const timeoutId = setTimeout(() => {
          readyWaitersRef.current = readyWaitersRef.current.filter(
            (waiter) => waiter !== done
          );
          resolve(deviceIdRef.current);
        }, DEVICE_READY_TIMEOUT_MS);

        const done = (id: string | undefined) => {
          clearTimeout(timeoutId);
          resolve(id);
        };

        readyWaitersRef.current.push(done);
      }),
    []
  );

  const ensureDeviceReady = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      const player = spotifyPlayerRef.current;
      if (!player) return undefined;

      if (deviceIdRef.current && !force) {
        return deviceIdRef.current;
      }

      if (reconnectPromiseRef.current) {
        return reconnectPromiseRef.current;
      }

      const reconnect = (async () => {
        console.log("[spotify] Reconnecting playback device…", { force });
        const ready = waitForReady();

        if (force) {
          // The server forgot our device: drop the stale session entirely.
          deviceIdRef.current = undefined;
          player.disconnect();
        }

        const connected = await player.connect();
        if (!connected) {
          console.warn("[spotify] player.connect() returned false");
        }

        const id = await ready;
        console.log("[spotify] Device after reconnect:", id ?? "none");
        return id;
      })().finally(() => {
        reconnectPromiseRef.current = null;
      });

      reconnectPromiseRef.current = reconnect;
      return reconnect;
    },
    [waitForReady]
  );

  /** Create the Spotify player once and connect it. */
  const handleConnectToSpotify = useCallback(async () => {
    setHasError(false);

    // Only ever create a single Player: creating one per token change leaves
    // several "iPod.js" devices around, and playback can be sent to one whose
    // audio element was never activated (silence / stuck loading).
    if (spotifyPlayerRef.current || !accessTokenRef.current) {
      return;
    }

    try {
      const player = new window.Spotify.Player({
        name: "iPod.js",
        getOAuthToken: async (cb) => {
          // The SDK calls this on connect and whenever its token expires.
          // Timers are frozen while iOS keeps the app in the background, so
          // the stored token may already be expired by the time we get here.
          const token = await getFreshAccessToken();
          if (!token) {
            console.error(
              "handleConnectToSpotify: Access token was not provided"
            );
            return;
          }

          cb(token);
        },
      });

      player.addListener("ready", ({ device_id }) => {
        console.log("[spotify] Device ready:", device_id);
        deviceIdRef.current = device_id;
        setDeviceId(device_id);
        setIsSpotifyAuthorized(true);
        setIsPlayerConnected(true);
        resolveReadyWaiters(device_id);
      });

      // Fired when the device goes offline (network change, app suspended…).
      // Without handling it, we'd keep sending playback to a dead device id.
      player.addListener("not_ready", ({ device_id }) => {
        console.warn("[spotify] Device went offline:", device_id);
        if (deviceIdRef.current === device_id) {
          deviceIdRef.current = undefined;
          setDeviceId(undefined);
        }
      });

      player.addListener("initialization_error", ({ message }) => {
        console.error(`Spotify initialization error: ${message}`);
        setHasError(true);
      });

      player.addListener("authentication_error", ({ message }) => {
        console.error(`Spotify authentication error: ${message}`);
        setIsSpotifyAuthorized(false);
        setHasError(true);
      });

      /** This indicates that the user is using an unsupported account tier. */
      player.addListener("account_error", () => {
        handleUnsupportedAccountError();
        setIsSpotifyAuthorized(false);
        setHasError(true);

        SpotifyUtils.logOutSpotify();
      });

      player.addListener("playback_error", ({ message }) => {
        console.warn("Spotify playback error:", message);
      });

      spotifyPlayerRef.current = player;
      player.connect();
    } catch (e) {
      console.error("Spotify player initialization error:", e);
      setHasError(true);
    }
  }, [
    getFreshAccessToken,
    handleUnsupportedAccountError,
    resolveReadyWaiters,
    setIsSpotifyAuthorized,
  ]);

  // Refresh the access token every 45 minutes (while the app is in the foreground).
  useInterval(handleRefreshTokens, TOKEN_MAX_AGE_MS, !accessToken);

  useEffect(() => {
    if (isSdkReady && typeof accessToken === "string" && !isPlayerConnected) {
      handleConnectToSpotify();
    }
  }, [handleConnectToSpotify, isSdkReady, accessToken, isPlayerConnected]);

  // iOS freezes home-screen apps in the background: timers stop and the SDK's
  // connection to Spotify is dropped. When we come back, make sure the token
  // is fresh and the playback device is still registered.
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== "visible" || !spotifyPlayerRef.current) {
        return;
      }

      await getFreshAccessToken();
      await ensureDeviceReady();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handleVisibilityChange);
    };
  }, [ensureDeviceReady, getFreshAccessToken]);

  const handleMount = useCallback(async () => {
    if (storedAccessToken) {
      const timestamp = Number(tokenLastRefreshedTimestamp);
      const needsRefresh = SpotifyUtils.checkShouldRefreshSpotifyTokens(timestamp);
      console.log("[spotify] Mount:", {
        hasStoredToken: true,
        tokenAgeMin: timestamp ? Math.round((Date.now() - timestamp) / 60000) : "unknown",
        needsRefresh,
      });
      if (needsRefresh) {
        await handleRefreshTokens();
      }
    } else {
      console.log("[spotify] Mount: no stored token found in cookie");
    }

    setIsSdkReady(true);
  }, [handleRefreshTokens, storedAccessToken, tokenLastRefreshedTimestamp]);

  useEffectOnce(() => {
    if (window.Spotify) {
      handleMount();
    } else {
      window.onSpotifyWebPlaybackSDKReady = handleMount;
    }
  });

  return (
    <SpotifySDKContext.Provider
      value={{
        spotifyPlayer: spotifyPlayerRef.current,
        accessToken,
        deviceId,
        isPlayerConnected,
        isSdkReady,
        hasError,
        refreshAccessToken: handleRefreshTokens,
        getFreshAccessToken,
        ensureDeviceReady,
      }}
    >
      {children}
    </SpotifySDKContext.Provider>
  );
};
