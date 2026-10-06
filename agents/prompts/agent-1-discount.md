Goal: the business wants a bulk discount: 10% off any line of 10 or more.
Start by making this fact true: claims/bulk-discount.json. Declare it, implement it, push, read the verdict.

If Canon rejects your attempt because it breaks the rule that the basket charges the listed price, that is
expected: the business really is changing its pricing rule, so that attempt can never land. Propose the change
as a revision instead, with exactly this command (no --join):

  canon claim --fact claims/price-with-bulk-discount.json --why "The business is changing its pricing rule for bulk buyers"

That gives you a NEW attempt. Implement the discount there (the same change), push, and read the verdict.
You are done only when that new attempt is READY and its verdict says RETIRES price-is-listed. A person approves rule changes.
