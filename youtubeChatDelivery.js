// Insert retries must distinguish a definite rejection from an unknown outcome.
// See https://developers.google.com/youtube/v3/live/docs/liveChatMessages/insert
export class YouTubeDeliveryError extends Error {
  constructor(message, { outcome, reason, retryAfterMs = 0, diagnostics, cause } = {}) {
    super(message, { cause });
    this.outcome = outcome;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
    this.diagnostics = diagnostics;
  }
}

// Keep only API response fields: Gaxios errors also contain OAuth credentials
// in their request config/headers and must never be serialized wholesale.
export function describeYouTubeFailure(error) {
  const apiError = error.response?.data?.error;
  const status = Number(error.response?.status || apiError?.code || error.code);
  const errors = apiError?.errors || error.errors || [];
  return {
    httpStatus: Number.isFinite(status) && status > 0 ? status : null,
    apiStatus: apiError?.status || null,
    message: typeof apiError === "string" ? apiError : apiError?.message || error.message,
    errors: errors.map(({ reason, domain, message, location, locationType }) => ({
      reason, domain, message, location, locationType,
    })),
  };
}

function classifyFailure(error, phase, context) {
  const status = Number(error.response?.status || error.code);
  const reasons = (error.response?.data?.error?.errors || error.errors || [])
    .map((item) => item.reason);
  const reason = reasons[0] || String(error.code || "unknown");
  const retryAfter = error.response?.headers?.get?.("retry-after")
    ?? error.response?.headers?.["retry-after"];
  const retryAfterMs = retryAfter == null ? 0 : Math.max(0,
    Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000
      : (Date.parse(retryAfter) || Date.now()) - Date.now());

  // Content, permission, quota, and ended-chat failures are final. In
  // particular, a generic 403 is not evidence of a temporary rate limit.
  const finalReasons = new Set([
    "messageTextInvalid", "messageTextRequired", "forbidden",
    "insufficientPermissions", "liveChatDisabled", "liveChatEnded",
    "liveChatNotFound", "quotaExceeded", "dailyLimitExceeded",
  ]);
  let outcome;
  if (reasons.some((value) => finalReasons.has(value))) {
    outcome = "rejected";
  } else if (status === 429 || reasons.some((value) =>
    ["rateLimitExceeded", "userRateLimitExceeded"].includes(value))) {
    outcome = "retry";
  } else if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(error.code)) {
    outcome = "retry"; // No connection was established to submit the comment.
  } else if (phase === "lookup" &&
    (!status || status === 408 || status >= 500)) {
    outcome = "retry"; // Only a GET has run; no insertion was attempted.
  } else if (status >= 400 && status < 500 && status !== 408) {
    outcome = "rejected";
  } else {
    // Includes POST timeouts, connection resets, and 5xx responses: YouTube
    // may have committed the insertion before the response was lost.
    outcome = "uncertain";
  }
  return new YouTubeDeliveryError(error.message, {
    outcome, reason, retryAfterMs, cause: error,
    diagnostics: { ...describeYouTubeFailure(error), phase, ...context },
  });
}

export function createYouTubeChatSender(youtube, { transformText = (text) => text } = {}) {
  const cache = new Map();
  return {
    clearCache() { cache.clear(); },
    async send(videoId, message) {
      let liveChatId = cache.get(videoId);
      if (!liveChatId) {
        let response;
        try {
          response = await youtube.videos.list({
            part: ["liveStreamingDetails"], id: videoId,
          }, { retry: false, timeout: 15000 });
        } catch (error) {
          throw classifyFailure(error, "lookup", { videoId });
        }
        const video = response.data.items?.[0];
        const details = video?.liveStreamingDetails;
        if (!video || details?.actualEndTime) {
          throw new YouTubeDeliveryError("The target stream is missing or ended.", {
            outcome: "rejected", reason: "streamEndedOrMissing",
          });
        }
        liveChatId = details?.activeLiveChatId;
        if (!liveChatId) {
          throw new YouTubeDeliveryError("The target live chat is not ready yet.", {
            outcome: "retry", reason: "chatNotReady",
          });
        }
        cache.set(videoId, liveChatId);
      }

      let response;
      let messageText;
      try {
        messageText = transformText(message);
        response = await youtube.liveChatMessages.insert({
          part: ["snippet"],
          resource: {
            snippet: {
              liveChatId, type: "textMessageEvent",
              textMessageDetails: { messageText },
            },
          },
        }, { retry: false, timeout: 15000 });
      } catch (error) {
        throw classifyFailure(error, "insert", {
          videoId, liveChatId,
          messageLength: typeof messageText === "string" ? [...messageText].length : null,
        });
      }
      if (!response.data?.id) {
        throw new YouTubeDeliveryError("YouTube returned no comment ID.", {
          outcome: "uncertain", reason: "missingCommentId",
        });
      }
      // An ID confirms API acceptance, not visibility or moderation approval.
      return { id: response.data.id, liveChatId };
    },
  };
}
