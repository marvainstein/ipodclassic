import { getSpotifyClientId } from "@/utils/constants/api";
import { getSpotifyRedirectUri } from "@/api/spotify/utils";
import { v4 as uuid } from "uuid";
import { redirect } from "next/navigation";

/**
 * Render a readable error page. A bare text/empty response makes iOS Safari
 * download it as "login.txt" instead of showing what went wrong.
 * Never include secret values here — only whether they are configured.
 */
const configErrorResponse = (problems: string[]) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify setup</title></head>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:24px;line-height:1.5">
<h2>Spotify login is not configured</h2>
<ul>${problems.map((p) => `<li>${p}</li>`).join("")}</ul>
<p>Add the missing values in Cloudflare → Workers → ipod-classic → Settings → Variables and Secrets, then deploy again.</p>
</body></html>`,
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

export async function GET() {
  const scope =
    "user-read-private user-read-email user-library-read user-follow-read playlist-read-collaborative playlist-read-private streaming user-read-playback-state user-read-currently-playing user-modify-playback-state";

  const problems: string[] = [];

  if (process.env.NODE_ENV !== "development" && !process.env.SITE_URL) {
    problems.push("<b>SITE_URL</b> is missing (e.g. ipod-classic.YOURNAME.workers.dev).");
  }

  let client_id: string | undefined;
  try {
    client_id = await getSpotifyClientId();
  } catch {
    client_id = undefined;
  }
  if (!client_id) {
    problems.push("<b>SPOTIFY_CLIENT_ID</b> is missing.");
  }

  if (problems.length) {
    console.error("[spotify/login] Missing configuration:", problems);
    return configErrorResponse(problems);
  }

  const redirect_uri = getSpotifyRedirectUri();
  const state: string = uuid();

  const authParams = new URLSearchParams({
    response_type: "code",
    client_id: client_id!,
    scope,
    redirect_uri,
    state,
  }).toString();

  redirect(`https://accounts.spotify.com/authorize/?${authParams}`);
}
