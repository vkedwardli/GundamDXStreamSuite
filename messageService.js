function getFormattedTime(date = new Date()) {
  const options = {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
    timeZone: "Asia/Hong_Kong",
  };
  const formatter = new Intl.DateTimeFormat("en-US", options);
  return formatter.format(date);
}

export function createMessage({
  isFederation = true,
  authorName,
  profilePic,
  message,
  plainMessage,
  timestamp,
}) {
  return {
    isFederation,
    time: getFormattedTime(timestamp),
    authorName,
    profilePic,
    message,
    plainMessage: plainMessage || message,
  };
}
