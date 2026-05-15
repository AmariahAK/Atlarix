const { readFile } = require("fs/promises");

module.exports = async function main({ id }) {
  const data = await readFile(id, "utf8");
  return { data };
};

async function helper(x, y) {
  return x + y;
}
