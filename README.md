# TriviaShrimp

A trivia game for one TV, one Windows laptop, and up to 24 players in phone browsers. The laptop serves the game, font, and QR code. Once the dependencies are installed, local Wi-Fi play works without internet access or router port forwarding.

## Run on Windows

Install a current [Node.js LTS](https://nodejs.org/en/download). Open PowerShell in this folder and run `npm.cmd ci` once to install the dependencies. Each game night, run:

```powershell
npm.cmd start
```

1. Wait for the terminal to print the **Join** link. Open [the host console](http://127.0.0.1:3001/host) on the laptop and click **Create room**.
2. Click **Open TV screen**, drag the new browser window onto the TV, and click the fullscreen button. The local address `http://127.0.0.1:3000/tv` also works for Song Quiz.
3. Scan the TV QR code on a phone and enter a nickname. Pick a question in the host console to start the timer. Pick an answer on the phone and try changing it before time runs out. Click **Reveal answer** once submissions close. Refresh the phone page and check that its nickname and score come back.

## Local Wi-Fi without a tunnel

Run `npm.cmd run start:local` and connect your phones to the same Wi-Fi as the laptop. The TV shows the laptop's local join address.

If the link uses the wrong adapter, run `ipconfig` and find **IPv4 Address** under the active Wi-Fi adapter. Put that address in a file named `.env` in this folder, then restart the server. For example:

```dotenv
LAN_IP=192.168.1.42
```

The phone should then be able to open `http://192.168.1.42:3000/play` with your actual address. If Windows Firewall prompts you on your trusted home network, allow Node.js on **Private networks**. Guest Wi-Fi may isolate devices even when they share a network name.

## How automatic tunneling works

`npm.cmd start` runs `cloudflared-windows-amd64.exe` from this folder. Once the new HTTPS join page responds, the app updates the TV QR code and visible join link. If Windows cannot resolve the new hostname, the launcher checks it through Cloudflare DNS without changing Windows settings. If startup still fails, it requests a fresh tunnel once. Allow about two minutes for both attempts.

Keep the PowerShell window open during play. Press **Ctrl+C** to stop both the app and its tunnel. If both startup attempts fail or the running tunnel exits, the app falls back to the local Wi-Fi address and prints the reason. If the launcher used Cloudflare DNS, test the QR on a phone before sharing it.

A Quick Tunnel needs internet access and gets a new address each time it starts. Anyone with the address can reach the player and TV views. The host console stays on the laptop at port **3001**. Cloudflare offers Quick Tunnels without an account, domain, or uptime guarantee. [Cloudflare Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

If you manage a public address yourself, you can enter it under **Change join address → Public join URL**. To use a `PUBLIC_JOIN_URL` from `.env` at startup, run `node --env-file-if-exists=.env server.js`.

## Play and score

- **Four-answer quiz** gives players **30 seconds** to answer. **Higher / Lower** gives them **20 seconds**. Selecting the question starts the timer and opens submissions. Players can change their answer until submissions close. The server scores the last saved choice when you reveal the answer, awarding 100 points for a correct answer.
- **Jeopardy** opens the buzzer for **15 seconds** when you select a clue. The first valid buzz received by the server stops the clock and wins the attempt. A correct spoken answer earns the clue's value. An incorrect answer deducts it. Reopen for another 15 seconds for players who have yet to buzz, or reveal the answer and return to the board. Revealed clues are marked used.
- **Song Quiz** plays a local MP3 from the TV window. Select a song, then use **Play on TV** in the host console or **Play clip** in the TV window. Players can buzz as soon as audio starts, and the first buzz pauses the clip. After marking a guess **Incorrect**, click **Resume on TV** in the host console or **Resume clip** in the TV window to continue from the pause point. Players who have already buzzed sit out for the rest of that song. When the clip ends, the buzzer stays open for **15 seconds**. If the browser blocks playback from the host console, use the playback button in the TV window. If sound comes from the laptop, select your TV or HDMI device in Windows sound output.
- **Number Guessing** gives players **30 seconds** to enter or revise a number on their phones. On reveal, the closest guess in either direction earns 100 points. Equally close players each earn 100 points.
- **Picture Buzz** shows the image clues and opens the buzzer for **15 seconds** when selected. In both Picture Buzz and Song Quiz, judge the spoken answer as correct (+100) or incorrect (−100). You can reopen the buzzer for eligible players after a miss.
- **Pause timer** freezes the countdown and keeps answers or buzzes open. **Resume timer** continues from the remaining time. Use **Close submissions** or **Close buzzer** to lock the round early.
- Switch modes between rounds. Players, scores, and used clues carry across modes. Use **Adjust score** to add or subtract points manually.
- Player recovery uses the same browser and join address. Keep the server running for the whole night. Stopping it clears the room and scores.

## Edit questions

The default pack includes General Trivia, Nintendo Games, Monster Hunter World, Minecraft, and Classic Games in Four-answer Quiz, Higher / Lower, and Number Guessing. In the host console, use **Filter questions by topic** to pick a category. Song Quiz has ten vocal-free, synthesized versions of recognizable hooks. Jeopardy and Picture Buzz are empty in this pack.

The previous pack is saved as `question-pack.json.old`. Set `QUESTION_PACK=question-pack.json.old` in `.env` and restart to play it. Its media files are still in the `media` folder.

Open [question-pack.json](question-pack.json) in a text editor. Copy or replace entries in the corresponding section. Keep each `id` unique across the file. JSON strings use double quotes, and the final item in a list has no trailing comma.

| Section | Example entry |
| --- | --- |
| `quiz` | `{"id":"piano","prompt":"How many keys on a standard piano?","options":["72","80","88","96"],"correctIndex":2}` |
| `higherLower` | `{"id":"orbits","prompt":"Is the second orbit longer?","knownItem":"Mars","knownValue":687,"secondItem":"Jupiter","secondValue":4333,"unit":"Earth days"}` |
| `jeopardy.categories[].clues` | `{"id":"rome","value":100,"prompt":"This city is home to the Colosseum.","answer":"Rome"}` |
| `songQuiz` | `{"id":"song-3","label":"Round 3","prompt":"Name the tune.","answer":"Song title","audio":{"file":"my-song.mp3","start":42,"duration":8}}` |
| `numberGuess` | `{"id":"distance","prompt":"How long is a full marathon in kilometres?","answer":42.195,"unit":"km"}` |
| `pictureBuzz` | `{"id":"leaf-flag","prompt":"Which country's flag features this leaf?","answer":"Canada","images":[{"file":"maple-leaf.png","alt":"A red maple leaf"}]}` |

Put media files in the `media` folder alongside your question pack JSON. In `file`, write the filename relative to that folder, such as `songs/my-song.mp3`. Song `start` and `duration` are in seconds and default to 0 and 10. The optional `label` appears only in the host's question list. The default Song Quiz clips live in `media/song-quiz`.

You can add an `images` array to a Four-answer quiz or Higher / Lower question, too. For example, add `"images": [{"file":"maple-leaf.png","alt":"A red maple leaf"}]` alongside the question's other fields. Each question can have up to four local PNG, JPEG, WebP, GIF, or AVIF images. Images and their alt descriptions appear on the TV and phones. Number Guessing accepts values from −1 billion to 1 billion with up to six decimal places.

`correctIndex` counts from zero. Higher / Lower requires two different numbers in the same units. Use `"unit": "year"` for dates to display years without thousands separators. Each Jeopardy category needs one clue for every point value in `jeopardy.values`. An optional `explanation` can add context to the reveal. Add a `topic` to questions in any list-based mode to include them in the host’s topic filter. You can set `QUESTION_PACK=my-pack.json` in `.env` to load a separate file.

Run `npm.cmd run check:questions` to validate the pack before the game. A validation error identifies the file and the question or category that needs attention. The server loads questions at startup, so restart it after editing.

Selected references for the default pack include the [World Athletics marathon distance](https://worldathletics.org/disciplines/road-running-event/marathon), Nintendo’s [Wii Sports Resort overview](https://www.nintendo.com/en-gb/News/2009/See-Wii-Sports-Resort-in-action-at-the-new-official-website-251650.html), [Capcom’s Monster Hunter: World listing](https://store.steampowered.com/app/582010/Monster_Hunter_World/), [Minecraft’s Ender Dragon guide](https://www.minecraft.net/en-us/article/ender-dragon), the [official history of Tetris](https://www.tetris.com/about), and [Blizzard’s Overwatch launch roster](https://overwatch.blizzard.com/en-us/news/20100169/play-overwatch%C2%AE-free-may-5%E2%80%939-during-the-open-beta-4-17-2016/).

## Checks

Run `npm.cmd test` for the multiplayer integration tests. Before game night, try scanning the TV from where people will sit, and complete a round on two real phones using your Wi-Fi. If using a tunnel, repeat the phone test with the actual temporary URL.
