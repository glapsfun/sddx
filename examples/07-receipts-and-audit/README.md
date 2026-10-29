# Example: receipts and audit

Every finished task leaves a receipt: the evidence of its boundary proof, the
review it passed, and the plan it came from, hash-chained to the receipts before
it. This example finishes a task, reads its receipt, audits the chain, then
tampers with it. See
[verify-and-audit-receipts](../../docs/how-to/verify-and-audit-receipts.md) and
[receipts-schema](../../docs/reference/receipts-schema.md).

## Setup

```sh skip
bash examples/07-receipts-and-audit/setup.sh
```

```sh
SDDX="$PWD/sddx"
ROOT="$PWD"
SPEC=.sddx/specs/2026-01-01-receipt.md
mkdir -p .sddx/specs
cat > "$SPEC" <<'EOF'
# Receipt demo

## Design

### Goal
Produce one receipt.

### Acceptance
- r-1 writes its marker

### Non-goals

### Assumptions
- markers are enough for a demo

### Open decisions

## Tasks

### r-1 Marker

~~~sddx
oracle: {type: command, run: test -f r.done, expect: exit 0}
scope: [r.done]
~~~
EOF
git add "$SPEC"
git commit -q -m "plan: receipt"
"$SDDX" plan approve "$SPEC" --harness example
"$SDDX" plan start "$SPEC"
"$SDDX" task start r-1
echo done > "$ROOT/.sddx-worktrees/r-1/r.done"
"$SDDX" verify r-1
"$SDDX" review record r-1 --verdict pass --reviewer you
git merge -q --no-ff -m "merge receipt demo" sddx/run-2026-01-01-receipt
```

## Read the receipt

```sh
R=.sddx/receipts/r-1.json
grep '"version": 5' "$R"
grep '"prev": "genesis"' "$R"
grep -A2 '"boundary"' "$R"
grep '"reviewer": "you"' "$R"
grep '"binding": "unsigned"' "$R"
grep '"markers are enough for a demo"' "$R"
```

`binding` is `unsigned` because no SSH signing key is configured: the approval
token proves which plan ran, not who approved it.

## Audit the chain

```sh
"$SDDX" audit
"$SDDX" audit | grep "human approval not provable"
"$SDDX" audit | grep "harness example (reported, not verified)"
"$SDDX" audit | grep "a recorded review, not a verified one"
```

## Tamper with it

Receipts are written read-only. Editing one anyway changes its bytes, which
audit catches against the commit that introduced it:

```sh
chmod u+w "$R"
sed -i.bak 's/"reviewer": "you"/"reviewer": "someone else"/' "$R"
rm "$R.bak"
```

```sh expect=1
"$SDDX" audit
```

```sh
"$SDDX" audit 2>&1 | grep "receipt bytes tampered"
git checkout -- "$R"
"$SDDX" audit
```
