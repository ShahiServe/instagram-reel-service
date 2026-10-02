require("dotenv").config();

const express =
  require("express");

const reelRouter =
  require("./routes/reel");

const app =
  express();

/*
 * JSON body parser
 *
 * We only receive a URL,
 * so 10 KB is more than enough.
 */
app.use(
  express.json({
    limit: "10kb",
  })
);


/*
 * Health check
 */
app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      message:
        "Instagram Reel Resolver API is running",
    });
  }
);


/*
 * Reel API
 */
app.use(
  "/",
  reelRouter
);


const PORT =
  process.env.PORT || 3000;


app.listen(
  PORT,
  () => {
    console.log(
      `Server running on http://localhost:${PORT}`
    );
  }
);