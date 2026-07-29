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
SDDX="$PWD/sddx"
ROOT="$PWD"
cat > graph.yaml <<'EOF'
schema_version: "1.0"
interaction_mode: human
goal: produce a receipt to inspect
tasks:
  - alias: receipts
    spec: spec.yaml
EOF
"$SDDX" graph approve --graph graph.yaml
OUT=$("$SDDX" graph create --graph graph.yaml)
echo "$OUT"
ID=$(echo "$OUT" | grep -o 'created [0-9]\{8\}-[a-z0-9-]*' | head -1 | awk '{print $2}')
cd "$ROOT/.sddx-worktrees/$ID"
"$SDDX" task phase "$ID" RED --test-exit 1
"$SDDX" red-check "$ID"
touch ok.txt
"$SDDX" task phase "$ID" GREEN --test-exit 0
"$SDDX" task phase "$ID" VERIFY
"$SDDX" verify "$ID"
```

The task ran in its own worktree, so the receipt below lives there too — the
rest of this example runs from inside it.

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
"$SDDX" audit 2>&1 | grep -q "chain intact"
```

## Tamper with it, and watch audit catch it

```sh
sed -i.bak 's/"exit_code": 0/"exit_code": 1/' ".sddx/receipts/$ID.json"
rm -f ".sddx/receipts/$ID.json.bak"
```

```sh
"$SDDX" audit 2>&1 | grep -q "tampered"
```

## Restore it, and confirm the chain is intact again

```sh
git checkout -- ".sddx/receipts/$ID.json"
```

```sh
"$SDDX" audit 2>&1 | grep -q "chain intact"
```

The receipt was never re-written to fix the tamper — it was restored to its
committed bytes. Receipts are immutable; the only legitimate way to change
one is to never have written the wrong one, which is exactly what the hash
chain exists to prove after the fact.
