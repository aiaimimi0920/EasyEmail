// These cases characterize existing extraction behavior across runtime boundaries.
export const otpCases = [
  {
    name: "verification context wins over tracking numbers",
    input: { subject: "Order #834211 has shipped", textBody: "Your verification code is 654321. Ignore tracking number 834211." },
    expected: { code: "654321", source: "text" },
  },
  {
    name: "standalone order numbers are rejected",
    input: { textBody: "Order number 123456 has been processed successfully." },
    expected: undefined,
  },
  {
    name: "subject-only six-digit codes remain supported",
    input: { subject: "731942" },
    expected: { code: "731942", source: "subject" },
  },
  {
    name: "ambiguous numbers without verification context are rejected",
    input: { textBody: "Use room 112233 and invoice 445566 for support." },
    expected: undefined,
  },
  {
    name: "five-digit login codes remain supported",
    input: { textBody: "Your login code is 48392 and expires in 10 minutes." },
    expected: { code: "48392", source: "text" },
  },
  {
    name: "mixed codes remain supported",
    input: { textBody: "Verification code: A7X9Q2. Enter it to continue." },
    expected: { code: "A7X9Q2", source: "text" },
  },
  {
    name: "uppercase letter codes remain supported",
    input: { textBody: "Your verification code is QWERTY. Enter it to continue." },
    expected: { code: "QWERTY", source: "text" },
  },
  {
    name: "grouped tokens are not truncated",
    input: { textBody: "Account 220044 requires confirmation. Verification code: ZX-41Q8-PLM7. Ignore ticket 771199." },
    expected: { code: "ZX-41Q8-PLM7", source: "text" },
  },
  {
    name: "HTML-adjacent text does not become part of numeric codes",
    input: { htmlBody: "<div>Your one-time verification code is <strong>445566Use</strong> this to continue.</div>", textBody: "Your one-time verification code is 445566Use this to continue." },
    expected: { code: "445566", source: "text" },
  },
  {
    name: "mixed primary codes win over backup IDs",
    input: { textBody: "Primary code: A1B2C3. Ignore backup id 998877." },
    expected: { code: "A1B2C3", source: "text" },
  },
  {
    name: "glued words are removed from primary codes",
    input: { textBody: "Order #20260428Primary code: A1B2C3Ignore backup id 998877." },
    expected: { code: "A1B2C3", source: "text" },
  },
  {
    name: "empty messages do not yield a code",
    input: {},
    expected: undefined,
  },
  {
    name: "Chinese verification context remains supported",
    input: { textBody: "您的验证码：735296，请在五分钟内使用。" },
    expected: { code: "735296", source: "text" },
  },
  {
    name: "multiple contextual codes preserve candidates",
    input: { textBody: "Verification code: 123456. Login code: 654321." },
    expected: { code: "123456", source: "text", candidates: ["123456", "654321"] },
  },
];
