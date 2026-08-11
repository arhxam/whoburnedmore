/// Shared last-known-good policy for provider telemetry.
///
/// A failed poll is not an authoritative zero. Accept it only before any valid
/// data has been observed (so first-run diagnostics still render), or when the
/// caller explicitly knows the provider was disconnected/disabled. Explicit
/// resets arrive as valid samples containing 0 and are therefore accepted.
public enum ProviderSamplePolicy {
    public static func shouldAccept(
        previousHasData: Bool,
        incomingHasData: Bool,
        authoritativeAbsence: Bool = false
    ) -> Bool {
        incomingHasData || !previousHasData || authoritativeAbsence
    }
}
