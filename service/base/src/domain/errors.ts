export interface EasyEmailErrorDetails {
  providerTypeKey?: string;
  providerInstanceId?: string;
  domain?: string;
}

export class EasyEmailError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Readonly<EasyEmailErrorDetails> = {},
  ) {
    super(message);
    this.name = "EasyEmailError";
  }
}
