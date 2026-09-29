// SPDX-License-Identifier: Apache-2.0
// Minimal typing for the Khronos glTF-Validator npm package (Apache-2.0), which ships no declarations.
declare module 'gltf-validator' {
  export interface ValidatorMessage {
    code: string;
    message: string;
    severity: number;
    pointer?: string;
  }
  export interface ValidatorReport {
    issues: { numErrors: number; numWarnings: number; numInfos: number; messages: ValidatorMessage[] };
  }
  export function validateBytes(
    data: Uint8Array,
    options?: { maxIssues?: number; uri?: string },
  ): Promise<ValidatorReport>;
  export function version(): string;
}
