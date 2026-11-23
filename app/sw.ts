/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { ExpirationPlugin, NetworkOnly, Serwist, StaleWhileRevalidate } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    {
      matcher: /\/ipod\/api\/.*/,
      handler: new NetworkOnly(),
    },
    {
      // Never cache Spotify Web API / auth responses. The default
      // "cross-origin" rule would serve them NetworkFirst with a 10s timeout
      // from a shared cache that ignores the Authorization header.
      matcher: ({ url }) =>
        url.hostname === "api.spotify.com" ||
        url.hostname === "accounts.spotify.com",
      handler: new NetworkOnly(),
    },
    {
      matcher: ({ url }) =>
        url.hostname === "sdk.scdn.co" ||
        url.hostname === "js-cdn.music.apple.com",
      handler: new StaleWhileRevalidate({
        cacheName: "third-party-sdks",
        plugins: [
          new ExpirationPlugin({ maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 }),
        ],
      }),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/ipod/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
