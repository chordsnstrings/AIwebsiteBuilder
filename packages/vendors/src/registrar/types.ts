// The DomainRegistrar capability. Two invariants matter more than the feature
// set: (1) requestTransferOut() ALWAYS succeeds — a customer's domain is their
// property and no outage, billing state or lock may hold it; (2) the reseller
// credit balance is a first-class readable field, because running out of credit
// is a silent failure that stops go-live without throwing anything.
export type DomainStatus = "available" | "registered" | "transfer_pending" | "expired";

export interface DomainRegistration {
  domain: string;
  status: DomainStatus;
  years: number;
  registeredAt: string;
  expiresAt: string;
}

export interface TransferOutAuth {
  domain: string;
  authCode: string;
  unlocked: boolean;
}

export interface DomainRegistrar {
  readonly vendorId: string;
  /** Days of prepaid reseller credit left. The Sentinel probe reads this. */
  readonly creditBalanceDays: number;
  checkAvailability(domain: string): Promise<boolean>;
  register(domain: string, years: number): Promise<DomainRegistration>;
  status(domain: string): Promise<DomainStatus>;
  requestTransferOut(domain: string): Promise<TransferOutAuth>;
}
