export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidJobError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_JOB');
  }
}
export class InvalidExternalDataError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_EXTERNAL_DATA');
  }
}
export class ApplicationResolutionError extends DomainError {
  constructor(message: string) {
    super(message, 'APPLICATION_RESOLUTION_ERROR');
  }
}
export class UnsupportedApplicationTypeError extends DomainError {
  constructor(message: string) {
    super(message, 'UNSUPPORTED_APPLICATION_TYPE');
  }
}
export class HumanReviewRequiredError extends DomainError {
  constructor(message: string) {
    super(message, 'HUMAN_REVIEW_REQUIRED');
  }
}
export class ExternalServiceError extends DomainError {
  constructor(message: string) {
    super(message, 'EXTERNAL_SERVICE_ERROR');
  }
}
