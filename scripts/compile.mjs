import fs from "node:fs";
import path from "node:path";
import solc from "solc";
const sources = Object.fromEntries(
  [
    "contracts/TownRefund.sol",
    "contracts/test/Fixtures.sol",
    "contracts/test/vendor/TownToken.sol",
    "contracts/test/vendor/ExodusDAO.sol",
  ].map((f) => [f, { content: fs.readFileSync(f, "utf8") }]),
);
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "paris",
        outputSelection: {
          "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] },
        },
      },
    }),
    {
      import: (p) => {
        try {
          return {
            contents: fs.readFileSync(path.join("node_modules", p), "utf8"),
          };
        } catch {
          return { error: `Missing ${p}` };
        }
      },
    },
  ),
);
for (const error of output.errors ?? []) {
  console.error(error.formattedMessage);
}
if (output.errors?.some((e) => e.severity === "error")) process.exit(1);
for (const [file, contracts] of Object.entries(output.contracts))
  for (const [name, c] of Object.entries(contracts)) {
    const dir = `artifacts/${file}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      `${dir}/${name}.json`,
      JSON.stringify(
        {
          _format: "hh-sol-artifact-1",
          contractName: name,
          sourceName: file,
          abi: c.abi,
          bytecode: "0x" + c.evm.bytecode.object,
          deployedBytecode: "0x" + c.evm.deployedBytecode.object,
          immutableReferences: c.evm.deployedBytecode.immutableReferences,
          linkReferences: {},
          deployedLinkReferences: {},
        },
        null,
        2,
      ),
    );
  }
console.log("Compiled with solc " + solc.version());
