# Example: oracle types

Proves, rather than just states, that `command`/`test-suite`/`browser`
oracles execute identically — the same `oracle.run` shell command, the same
verifier code path — and shows today's real limitation with `manual`:
`sddx verify` refuses it outright.

## Setup

```sh skip
bash examples/06-oracle-types/setup.sh
```

`cd` into the printed directory before running anything below.

## The three automated types run identically

```sh
ROOT="$PWD"
for TYPE in command test-suite browser; do
  cat > "spec-$TYPE.yaml" <<EOF
task: oracle type demo $TYPE
success_criteria:
  - "ok-$TYPE.txt exists"
oracle:
  type: $TYPE
  run: "test -f ok-$TYPE.txt"
  expect: exit 0
EOF
done
```

(A real `browser` oracle would run something like `bunx playwright test
e2e/login.spec.ts` — this example substitutes a dependency-free stand-in so
it runs fully offline; the mechanics below are identical either way, since
`type` never changes how `run` executes.)

```sh
for TYPE in command test-suite browser; do
  OUT=$(./sddx task create --spec "spec-$TYPE.yaml" --workspace none)
  ID=$(echo "$OUT" | awk '{print $2}')
  echo "$ID" > "id-$TYPE.txt"
  ./sddx task phase "$ID" RED --test-exit 1
  ./sddx red-check "$ID"
  touch "ok-$TYPE.txt"
  ./sddx task phase "$ID" GREEN --test-exit 0
  ./sddx task phase "$ID" VERIFY
  ./sddx verify "$ID"
done
```

All three reach `verdict=pass` through the exact same code path — swapping
`type` never changed the mechanics, only what a reader understands the
command is proving.

## `manual` is accepted, but `verify` refuses it today

```sh
cat > spec-manual.yaml <<'EOF'
task: oracle type demo manual
success_criteria:
  - "a human confirms the page renders correctly"
oracle:
  type: manual
  run: ""
  expect: "human approves the rendered page"
EOF
OUT=$(./sddx task create --spec spec-manual.yaml --workspace none)
MANUAL_ID=$(echo "$OUT" | awk '{print $2}')
./sddx task phase "$MANUAL_ID" RED --test-exit 1
./sddx task phase "$MANUAL_ID" GREEN --test-exit 0
./sddx task phase "$MANUAL_ID" VERIFY
```

```sh
./sddx verify "$MANUAL_ID" 2>&1 | grep -q "manual oracles need a human decision"
```

The spec parser accepts `type: manual` with an empty `run` — registration
never rejects it — but today's verifier refuses to settle it. Until that
changes, a genuinely non-automatable outcome needs a different oracle
shaped as a proxy check (a file a human touches after reviewing, a status
endpoint a human flips) rather than `type: manual` itself.
