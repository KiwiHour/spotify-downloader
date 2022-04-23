const SpotifyWebApi = require('spotify-web-api-node');
const readline = require("readline")
const fs = require("fs").promises
const { createWriteStream } = require("fs")
const ftp = require("promise-ftp")
const webbrowser = require("open")
const SpotifyToYoutube = require("spotify-to-youtube")
const exec = require("await-exec")
const fetch = require("node-fetch")
const app = require("express")()
const request = require("request")
const querystring = require("query-string")

async function asyncInput(query) {
    const interface = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => interface.question(query, ans => {
        interface.close()
        resolve(ans)
    }))
}

async function asyncPasswordInput(query) {
	var rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	return new Promise(resolve => {
		rl.question(query, function(password) {
			console.log()
			resolve(password)
			rl.close();
		});
		
		rl._writeToOutput = function _writeToOutput() {
			rl.output.write("\x1B[2K\x1B[200D"+query+"["+((rl.line.length%2==1)?"=-":"-=")+"]");
		};
	})
}

async function asyncStreamWrite(stream, dir) {
	return new Promise(resolve => {
		stream.pipe(createWriteStream(dir)).on("finish", () => {
			resolve(true)
		})
	})
}

async function getStreamJSON(stream) {
	return new Promise(async resolve => {
		await asyncStreamWrite(stream, "temp.json")
		let json_data = JSON.parse((await fs.readFile("temp.json")))
		await fs.unlink("temp.json")
		resolve(json_data)
	})
}

class SpotifyAPI {
	constructor({ access_token }) {
		this.controller = new SpotifyWebApi()
		this.controller.setAccessToken(access_token)
		this.access_token = access_token
		this.require_scopes = ["playlist-modify-public", "playlist-modify-private", "playlist-read-private"]
		this.opened_browser = false
		this.isTokenValid = false
	}

	async connect() {
		return new Promise(async resolve => {
			this.isTokenValid = await this.validateToken()
			if (this.isTokenValid) { resolve(true) }
			else { webbrowser("http://localhost:4050/") }
		})
	}

	// async getToken() {
	// 	return new Promise(async resolve => {
	// 		this.isTokenValid = await this.validateToken()
	// 		if (this.isTokenValid) {
	// 			console.log("\nConnected to Spotify".green.bold)
	// 			await fs.writeFile(__dirname + "/access_token.txt", this.access_token)
	// 			resolve(true) 
	// 		} else {
	// 			if (!this.opened_browser) {
	// 				webbrowser("https://developer.spotify.com/console/get-track")
	// 				this.opened_browser = true
	// 			}
	// 			this.access_token = await asyncInput("Enter new token: ".green)
	// 			this.controller.setAccessToken(this.access_token)
	// 			await this.getToken()
	// 			resolve(false)
	// 		}
	// 	})
	// }

	async validateToken() {
		return new Promise(async resolve => {
			this.controller.getPlaylist().then(null, async ({ body }) => {
				if (["Invalid access token","The access token expired","No token provided"].includes(body.error.message)) {
					// console.log(body.error.message.red.bold)
					// console.log("Scopes: ".green + this.require_scopes.map(scope => scope.yellow).join(" + "))
					resolve(false) }
				// only playlist id is incorrect, therefore token is valid
				if (body.error.message == "Invalid playlist Id") { resolve(true) }
			})
		})
	}

	async getTrack(track_id) {
		return new Promise(async resolve => {
			try {
				let track = await this.controller.getTrack(track_id)
				resolve(track.body)
			} catch (error) {
				if (!error.message.includes("invalid id")) { throw error }
				else { resolve(false) }
			}
		})
	}

	async getPlaylistTracks(playlist_id) {
		return new Promise(async resolve => {
			let playlist_tracks = await this.controller.getPlaylistTracks(playlist_id)
			resolve(playlist_tracks.body.items.map(track => track.track))
		})
	}
}

class FTP {
	constructor({ config, dir, root_dir }) {
		this.config = config
		this.dir = dir
		this.root_dir = root_dir
	}

	async connect() {
		return new Promise(async resolve => {
			await this.getPassword()
			this.isPasswordValid = await this.validatePassword()
			if (this.isPasswordValid) {
				console.log("Connected to FTP".green.bold)
				this.controller = new ftp()
				await this.controller.connect(this.config)
				resolve(true)
			} else {
				console.log("Invalid Password".red.bold)
				await this.connect()
			}
		})
	}

	async disconnect() {
		this.controller.end()
	}

	async validatePassword() {
		return new Promise(async resolve => {
			this.controller = new ftp()
			try {
				await this.controller.connect(this.config)
				resolve(true)
			} catch (error) { 
				if (error.message == "Authentication failed.") { resolve(false) }
			}
		})
	}

	async getPassword() {
		return new Promise(async resolve => {
			this.config.password = await asyncPasswordInput("Enter FTP password: ".green)
			resolve(true)
		})
	}

	async directoryExists(directory) {
		return new Promise(async resolve => {
			const files = await this.controller.list(this.dir)
			const directory_names = files.filter(file => file.type == "d").map(file => file.name)
			resolve(directory_names.includes(directory))
		})
	}



	async getMetadata(directory, playlist_id) {
		return new Promise(async resolve => {
			try {
				let metadata_stream = await this.controller.get(`${this.dir}/${directory}/.metadata.json`)
				let metadata = await getStreamJSON(metadata_stream)
				resolve(metadata)
			} catch (error) {
				console.log(`Missing metadata.json in folder ${`${this.dir}/${directory}`.bold}\nRe-building playlist`.red)
				await this.controller.rmdir(`${this.dir}/${directory}`)
				await playlists[playlist_id].manager.init()
				resolve("Missing metadata file")
			}	
		})
	}

	async writeMetadata(directory, metadata) {
		return new Promise(async resolve => {
			await fs.writeFile("temp-metadata.json", JSON.stringify(metadata))
			await this.controller.put("temp-metadata.json", `${this.dir}/${directory}/.metadata.json`)
			await fs.unlink("temp-metadata.json")

			resolve(true)
		})
	}

	async makeBlankMetadataFile(directory, playlist_id) {
		return new Promise(async resolve => {
			let blank_metadata = {
				playlist_id, tracks: []
			}

			await fs.writeFile("temp-metadata.json", JSON.stringify(blank_metadata))
			await this.controller.put("temp-metadata.json", `${this.dir}/${directory}/.metadata.json`)
			await fs.unlink("temp-metadata.json")

			resolve(true)
		})
	}

	async getDirectoryById(playlist_id) {
		return new Promise(async resolve => {
			const directories = await this.controller.list(this.dir)
			const directory_metadatas = {}
			for (i in directories) {
				let directory = directories[i]
				let metadata = await this.getMetadata(directory.name, playlist_id)
				directory_metadatas[metadata.playlist_id] = directory.name
			}
			resolve(directory_metadatas[playlist_id])
		})
	}

}

class PlaylistManager {
	constructor ({ SpotifyClient, FTPClient, playlist }) {
		this.SpotifyClient = SpotifyClient
		this.FTPClient = FTPClient
		this.playlist = playlist
		this.convertTrack = SpotifyToYoutube(this.SpotifyClient.controller)
	}

	async init() {
		return new Promise(async resolve => {
			console.log(`\nInitializing data from\nPlaylist: ${this.playlist.name.bold}\nID: ${this.playlist.id.bold}`.magenta)
			this.FTPClient.dir = this.FTPClient.root_dir

			this.playlist.tracks = (await this.SpotifyClient.getPlaylistTracks(this.playlist.id)).map(({ id, name, artists, album }) => {
				return { id, name, artist: artists[0].name, album }
			})

			// verify that Spotify parent folder exists
			if (!await this.FTPClient.directoryExists("Spotify")) {
				await this.FTPClient.controller.mkdir(this.FTPClient.dir + "/Spotify")
				console.log(`Created ${"Spotify".magenta} Folder`.magenta)
			}
			this.FTPClient.dir += "/Spotify"

			// verify playlist folder's integrity
			if (!await this.FTPClient.directoryExists(this.playlist.name)) {
				let directory = await this.FTPClient.getDirectoryById(this.playlist.id)
				if (directory == undefined) {
					await this.FTPClient.controller.mkdir(`${this.FTPClient.dir}/${this.playlist.name}`)
					console.log(`${"Created".magenta} ${"Folder".green} ${`for playlist ${this.playlist.name.bold}`.magenta}`)
					await this.FTPClient.makeBlankMetadataFile(this.playlist.name, this.playlist.id)
					console.log(`${"Created".magenta} ${"metadata file".green} ${`for playlist ${this.playlist.name.bold}`.magenta}`)
				}
			// verify that playlist folder has metadata file
			// if it doesnt then the folder will be rebuilt (re-download all songs)
			} else { await this.FTPClient.getDirectoryById(this.playlist.id) }

			this.directory = await this.FTPClient.getDirectoryById(this.playlist.id)
			
			this.metadata = (await this.FTPClient.getMetadata(this.directory, this.playlist.id))
			this.metadata.tracks = await Promise.all(
				this.metadata.tracks.map(async track => ({
					...(await this.SpotifyClient.getTrack(track.id)), file_name: track.file_name
				}))
			)


			this.downloaded_track_files = (await this.FTPClient.controller.list(`${this.FTPClient.dir}/${this.directory}`)).filter(file => file.name.slice(-4) == ".mp3" )
			this.downloaded_tracks = await Promise.all(this.downloaded_track_files.map(async file => {
				let track_id = (await this.metadata.tracks.find(track => track.file_name == file.name)).id
				let track = await this.SpotifyClient.getTrack(track_id)
				return { ...track, file_name: file.name }
			}))

			resolve(true)
		})
	}

	async downloadTrackById(track) {
		return new Promise(async resolve => {
			let yt_track_id = await this.convertTrack(track.id)
			await exec(`yt-dlp -o "${__dirname}\\Songs\\${track.name} - ${track.artist}preart.%(ext)s" ${yt_track_id} --extract-audio --audio-format mp3`)
			resolve(true)
		})
	}

	async downloadTrackArt(album_id, track) {
		return new Promise(async (resolve, reject) => {
			let track_art_url = (await this.SpotifyClient.controller.getAlbum(album_id)).body.images[0].url // highest resolution
			let track_file_name = `${track.name} - ${track.artist}`
			
			const response = await fetch(track_art_url)
			const buffer = await response.buffer()
			await fs.writeFile(`${__dirname}\\Songs\\${track_file_name}.png`, buffer)
			
			resolve(true)
		})
	}

	async assignTrackArt(track) {
		return new Promise(async resolve => {
			let file_name = `${track.name} - ${track.artist}`
			await exec(`ffmpeg -i "${__dirname}\\Songs\\${file_name}preart".mp3 -i "${__dirname}\\Songs\\${file_name}".png -map 0:0 -map 1:0 -c copy -id3v2_version 3 -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)" "${__dirname}\\Songs\\${file_name}".mp3`)
			await fs.unlink(`${__dirname}\\Songs\\${file_name}preart.mp3`)
			await fs.unlink(`${__dirname}\\Songs\\${file_name}.png`)
			resolve(true)
		})
	}

	async uploadTrack(file_name) {
		return new Promise(async resolve => {
			await this.FTPClient.controller.put(`${__dirname}\\Songs\\${file_name}`, `${this.FTPClient.dir}/${this.directory}/${file_name}`)
			resolve(true)
		})
	}

	async addTrackToMetadata(track) {
		return new Promise(async resolve => {
			let metadata = await this.FTPClient.getMetadata(this.directory, this.playlist.id)
			metadata.tracks.push({ id: track.id, file_name: `${track.name} - ${track.artist}.mp3` })
			await this.FTPClient.writeMetadata(this.directory, metadata)
			resolve(true)
		})
	}

	async removeTrackFromMetadata(track_id) {
		return new Promise(async resolve => {
			let metadata = await this.FTPClient.getMetadata(this.directory, this.playlist.id)
			metadata.tracks = metadata.tracks.filter(track => track.id != track_id)
			await this.FTPClient.writeMetadata(this.directory, metadata)
			resolve(true)
		})
	}

	async removeTracksFromPlaylist(playlist_id, track_ids) {
		return new Promise(async resolve => {
			let track_uris = track_ids.map(track_id => ({ uri: `spotify:track:${track_id}` }))
			await this.SpotifyClient.controller.removeTracksFromPlaylist(playlist_id, track_uris)
			resolve(true)
		})
	}

	async uploadMissingTracksToPhone() {
		return new Promise(async resolve => {
			this.tracks_to_download = this.playlist.tracks.filter(track =>
				! this.metadata.tracks.map(track => track.id).includes(track.id) 
			)
			// add to phone
			// add to metadata

			let downloaded_tracks = 0
			this.tracks_to_download.forEach(async (track, index) => {
				if (index == 0) { console.log(`Downloading tracks and cover art...`.magenta) }
				console.log(` - ${`${track.name} - ${track.artist}`.yellow}`)

				await this.downloadTrackById(track)
				await this.downloadTrackArt(track.album.id, track)
				await this.assignTrackArt(track)
				downloaded_tracks ++
			})
			await new Promise(resolve => {
				let wait_for_downloads = setInterval(async() => {
					if (downloaded_tracks == this.tracks_to_download.length) {
						resolve(true)
						clearInterval(wait_for_downloads)
					}
				}, 500)
			})
			for (let i in this.tracks_to_download) {
				let track = this.tracks_to_download[i]
				if (i == 0) { console.log(`Uploaded tracks to phone: `.magenta) }
				await this.uploadTrack(`${track.name} - ${track.artist}.mp3`)
				await fs.unlink(`${__dirname}\\Songs\\${track.name} - ${track.artist}.mp3`)
				await this.addTrackToMetadata(track)
				console.log(` - ${`${track.name} - ${track.artist}`.green}`)

				// init to refresh variables with new data, if data has been updated
				if (i == this.tracks_to_download.length-1) { await this.init() }
			}
	
			resolve(true)
		})
	}

	async removeExtraTracksFromPhone() {
		return new Promise(async resolve => {
			this.tracks_to_remove = this.downloaded_tracks.filter(track => (
				this.metadata.tracks.map(track => track.id).includes(track.id) &&
				! this.playlist.tracks.map(track => track.id).includes(track.id)
			))
			/// remove it from phone
			/// remove it from metadata

			for (i in this.tracks_to_remove) {
				let track = this.tracks_to_remove[i]
				if (i == 0) { console.log(`Removed tracks from phone: `.magenta) }
				await this.FTPClient.controller.delete(`${this.FTPClient.dir}/${this.directory}/${track.file_name}`)
				await this.removeTrackFromMetadata(track.id)
				console.log(` - ${`${track.name} - ${track.artists[0].name}`.green}`)

				// init to refresh variables with new data, if data has been updated
				if (i == this.tracks_to_remove.length-1) { await this.init() }
			}
			resolve(true)
		})
	}

	async removeExtraTracksFromPlaylist() {
		return new Promise(async resolve => {
			this.tracks_to_remove_from_playlist = this.playlist.tracks.filter(track => 
				! this.downloaded_tracks.map(track => track.id).includes(track.id) &&
				this.metadata.tracks.map(track => track.id).includes(track.id)
			)
			/// remove from playlist
			/// remove from metadata

			await this.removeTracksFromPlaylist(this.playlist.id, this.tracks_to_remove_from_playlist.map(track => track.id))
			for (i in this.tracks_to_remove_from_playlist) {
				let track = this.tracks_to_remove_from_playlist[i]
				if (i == 0) { console.log(`Removed tracks from spotify playlist: ${this.playlist.id}: `.magenta) }
				await this.removeTrackFromMetadata(track.id)
				console.log(` - ${`${track.name} - ${track.artist}`.green}`)
				
				// init to refresh variables with new data, if data has been updated
				if (i == this.tracks_to_remove_from_playlist.length-1) { await this.init() }
			}

			resolve(true)
		})
	}
}

// make global varaible so that FTPClient can access it to restore playlist folders
let playlists = {};

const main = async (access_token) => {

	playlists = {}

	const SpotifyClient = new SpotifyAPI({
		access_token
	})
	const FTPClient = new FTP({
		config: {
			host: "", // <----
			port: 2221, // <----
			user: "", // <----
		},
		dir: "", // <----
		root_dir: "" // <----
	})

	await SpotifyClient.connect()
	await FTPClient.connect()

	// console.log("putting episode")
	// await FTPClient.controller.put("E:\\Movies and Shows\\The Boys\\Season 2\\The Boys - S02E08 - What I Know.mkv", `E008.mkv`)
	// console.log("done")

	// await FTPClient.controller.put(__dirname + "\\Songs\\audio-out.mp3", `mp3/Spotify/Scrumptious Songs/audio-out.mp3`)

	const playlists_data = (await SpotifyClient.controller.getUserPlaylists("")).body.items  // <----

	// const track = await SpotifyClient.getTrack("1BApHcP5TM5DHAq4gyjqjx")
	// console.log(track.album.id)

	// let possible_track_art = await albumArt("The Doozers", { album: "Full Length Album"})
	// console.log(possible_track_art)

	// let album = await SpotifyClient.controller.getAlbum("0W3GSPbi8ns0PTFHCmp69i")
	// console.log(album.body.images)

	for (i in playlists_data) {
		let data = playlists_data[i]
		let manager = new PlaylistManager({ SpotifyClient, FTPClient, playlist: data })

		playlists[data.id] = { data, manager }
		
		await manager.init()
		
		// metadata:
		// console.log((await manager.FTPClient.getMetadata(manager.directory, manager.playlist.id)))
		
		await manager.removeExtraTracksFromPhone()
		await manager.uploadMissingTracksToPhone()
		await manager.removeExtraTracksFromPlaylist()

	}

	console.log("\nUp to date".magenta.bold)
	
	FTPClient.disconnect()
	process.exit()
	
}

const redirect_uri = "http://localhost:4050/spotify-callback"
const client_id = "" // <----
const client_secret = "" // <----
const scope = "playlist-modify-public playlist-modify-private playlist-read-private"
const state = "bcee1f067bb872b2"

app.get("/", (req, res) => {
	res.redirect("https://accounts.spotify.com/authorize?" + 
		querystring.stringify({
			response_type: "code",
			client_id, scope, redirect_uri, state
		})
	)
})

app.get("/spotify-callback", async (req, res) => {
    var code = req.query.code || null;
    var state = req.query.state || null;

  if (state === null) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (Buffer.from(`${client_id}:${client_secret}`).toString('base64'))
      },
      json: true
    };

	request.post("https://accounts.spotify.com/api/token", authOptions, async (err, response, body) => {
		if (err) { throw err }
		await fs.writeFile(__dirname + "/access_token.txt", body.access_token.toString())
		main(body.access_token)
		res.sendFile(__dirname + "\\close.html")
	})
	
  }
})

app.listen(4050, "", async () => main((await fs.readFile(__dirname + "\\access_token.txt"))))

require("colors")
