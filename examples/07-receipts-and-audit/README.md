# Example: receipts and audit

Completes one task, inspects its receipt, runs `sddx audit` clean, then
deliberately tampers with the receipt file and watches audit catch it —
loudly, not silently — before restoring it and confirming the chain is
intact again.

## Setup

```sh skip
bash examples/07-receipts-and-audit/setup.sh
```

`cd` into the printed directory before running anything below.

## Complete one task

```sh
cat > spec.yaml <<'EOF'
task: receipts example task
context: []
success_criteria:
  - "ok.txt exists"
oracle:
  type: command
  run: "test -f ok.txt"
  expect: exit 0
out_of_scope: []
EOF
OUT=$(./sddx task create --spec spec.yaml --workspace none)
echo "$OUT"
ID=$(echo "$OUT" | awk '{print $2}')
./sddx task phase "$ID" RED --test-exit 1
./sddx red-check "$ID"
touch ok.txt
./sddx task phase "$ID" GREEN --test-exit 0
./sddx task phase "$ID" VERIFY
./sddx verify "$ID"
```

## Inspect the receipt

```sh
cat ".sddx/receipts/$ID.json"
```

```sh
grep -o '"verdict": "pass"' ".sddx/receipts/$ID.json"
grep -o '"task_id": "'"$ID"'"' ".sddx/receipts/$ID.json"
```

(Receipts are written with `JSON.stringify(receipt, null, 2)` — a space
always follows each `:` in that output. If a future receipt format changes
this, adjust the grep pattern to match, not the other way round.)

## A clean audit

```sh
./sddx audit 2>&1 | grep -q "chain intact"
```

## Tamper with it, and watch audit catch it

```sh
sed -i.bak 's/"exit_code": 0/"exit_code": 1/' ".sddx/receipts/$ID.json"
rm -f ".sddx/receipts/$ID.json.bak"
```

```sh
./sddx audit 2>&1 | grep -q "tampered"
```

## Restore it, and confirm the chain is intact again

```sh
git checkout -- ".sddx/receipts/$ID.json"
```

```sh
./sddx audit 2>&1 | grep -q "chain intact"
```

The receipt was never re-written to fix the tamper — it was restored to its
committed bytes. Receipts are immutable; the only legitimate way to change
one is to never have written the wrong one, which is exactly what the hash
chain exists to prove after the fact.
