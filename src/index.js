require('dotenv').config();
const { createApp } = require('./server');

const PORT = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(PORT, () => {
  console.log(`Hoststringer mail app listening on http://localhost:${PORT}`);
});
