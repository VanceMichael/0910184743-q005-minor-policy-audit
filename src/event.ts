export type AccountEvent = Readonly<{
  eventId: string;
  tenantId: string;
  accountId: string;
  sourceSeq: number;
  kind: string;
}>;

export function assertEvent(event: AccountEvent): void {
  if (!event.eventId.trim() || !event.tenantId.trim() || !event.accountId.trim()) {
    throw new TypeError("事件、租户与账号标识不能为空");
  }
  if (!Number.isSafeInteger(event.sourceSeq) || event.sourceSeq < 1) {
    throw new TypeError("来源序号必须是正整数");
  }
}
