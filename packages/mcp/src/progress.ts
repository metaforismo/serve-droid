export interface McpProgressExtra {
  _meta?: { progressToken?: string | number | undefined };
  sendNotification(notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }): Promise<void>;
}

export async function reportMcpProgress(
  extra: McpProgressExtra,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
}
