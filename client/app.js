var COGNITO_DOMAIN = "https://us-east-1mtiw96nqr.auth.us-east-1.amazoncognito.com";
var CLIENT_ID = "12tsgmdcrmhr6ua7rmbdqbp5ht";
var REDIRECT_URI = window.location.origin + "/";
var API = "";

var loadButton = document.getElementById("loadButton");
var statusLine = document.getElementById("status");
var tableBody = document.getElementById("movieTableBody");
var average = document.getElementById("average");
var movieForm = document.getElementById("movieForm");
var result = document.getElementById("result");
var greeting = document.getElementById("greeting");
var loginButton = document.getElementById("loginButton");
var logoutButton = document.getElementById("logoutButton");
var submitButton = document.getElementById("submitButton");

var TITLE_PATTERN = /^[A-Za-z0-9 .,:'!?&()\-]+$/;

function randomString()
{
    var bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);

    var text = "";

    for (var i = 0; i < bytes.length; i++)
    {
        text = text + ("0" + bytes[i].toString(16)).slice(-2);
    }

    return text;
}

function toBase64Url(buffer)
{
    var bytes = new Uint8Array(buffer);
    var text = "";

    for (var i = 0; i < bytes.length; i++)
    {
        text = text + String.fromCharCode(bytes[i]);
    }

    return window.btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeChallenge(verifier)
{
    var data = new TextEncoder().encode(verifier);

    return window.crypto.subtle.digest("SHA-256", data).then(toBase64Url);
}

function startLogin()
{
    var verifier = randomString();
    sessionStorage.setItem("pkce_verifier", verifier);

    makeChallenge(verifier).then(function (challenge)
    {
        var url = COGNITO_DOMAIN + "/oauth2/authorize" +
            "?response_type=code" +
            "&client_id=" + encodeURIComponent(CLIENT_ID) +
            "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
            "&scope=" + encodeURIComponent("openid email profile") +
            "&code_challenge_method=S256" +
            "&code_challenge=" + challenge;

        window.location.href = url;
    });
}

function logout()
{
    sessionStorage.removeItem("id_token");

    var url = COGNITO_DOMAIN + "/logout" +
        "?client_id=" + encodeURIComponent(CLIENT_ID) +
        "&logout_uri=" + encodeURIComponent(REDIRECT_URI);

    window.location.href = url;
}

function exchangeCode(code)
{
    var verifier = sessionStorage.getItem("pkce_verifier") || "";

    var body = "grant_type=authorization_code" +
        "&client_id=" + encodeURIComponent(CLIENT_ID) +
        "&code=" + encodeURIComponent(code) +
        "&redirect_uri=" + encodeURIComponent(REDIRECT_URI) +
        "&code_verifier=" + encodeURIComponent(verifier);

    return fetch(COGNITO_DOMAIN + "/oauth2/token",
    {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body
    })
        .then(function (response)
        {
            return response.json();
        })
        .then(function (data)
        {
            if (data.id_token)
            {
                sessionStorage.setItem("id_token", data.id_token);
            }

            sessionStorage.removeItem("pkce_verifier");
        });
}

function readToken()
{
    var token = sessionStorage.getItem("id_token");

    if (!token)
    {
        return null;
    }

    var parts = token.split(".");

    if (parts.length !== 3)
    {
        sessionStorage.removeItem("id_token");
        return null;
    }

    try
    {
        var payload = JSON.parse(window.atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));

        if (payload.exp * 1000 < Date.now())
        {
            sessionStorage.removeItem("id_token");
            return null;
        }

        return {
            token: token,
            name: payload.email || payload["cognito:username"] || "user"
        };
    }
    catch (error)
    {
        sessionStorage.removeItem("id_token");
        return null;
    }
}

function showUser()
{
    var user = readToken();

    if (user)
    {
        greeting.textContent = "Hello, " + user.name;
        loginButton.classList.add("hidden");
        logoutButton.classList.remove("hidden");
        submitButton.disabled = false;
    }
    else
    {
        greeting.textContent = "Not signed in";
        loginButton.classList.remove("hidden");
        logoutButton.classList.add("hidden");
        submitButton.disabled = true;
    }
}

function addCell(row, text)
{
    var cell = document.createElement("td");
    cell.textContent = text;
    row.appendChild(cell);
}

function loadMovies()
{
    statusLine.textContent = "Loading...";
    tableBody.innerHTML = "";
    average.textContent = "";

    fetch(API + "/api/movies")
        .then(function (response)
        {
            return response.json();
        })
        .then(function (data)
        {
            for (var i = 0; i < data.movies.length; i++)
            {
                var movie = data.movies[i];
                var row = document.createElement("tr");

                addCell(row, movie.title);
                addCell(row, movie.score + " / 10");
                addCell(row, movie.username);
                addCell(row, movie.date);

                tableBody.appendChild(row);
            }

            statusLine.textContent = "Loaded " + data.movies.length + " ratings.";
            average.textContent = "Average score across everyone: " + data.average + " / 10";
        })
        .catch(function (error)
        {
            statusLine.textContent = "Could not load data. Is the server running?";
            console.log(error);
        });
}

function showResult(text, kind)
{
    result.textContent = text;
    result.className = kind;
    result.style.display = "block";
}

function submitRating(event)
{
    event.preventDefault();

    var user = readToken();

    if (!user)
    {
        showResult("Please sign in before adding a rating.", "bad");
        showUser();
        return;
    }

    var title = document.getElementById("title").value.trim().replace(/\s+/g, " ");
    var score = Number(document.getElementById("score").value);

    if (title.length < 1 || title.length > 60)
    {
        showResult("Title must be between 1 and 60 characters.", "bad");
        return;
    }

    if (!TITLE_PATTERN.test(title))
    {
        showResult("Title can only use letters, numbers, spaces and basic punctuation.", "bad");
        return;
    }

    if (!Number.isInteger(score) || score < 1 || score > 10)
    {
        showResult("Score must be a whole number from 1 to 10.", "bad");
        return;
    }

    showResult("Sending...", "normal");

    fetch(API + "/api/movies",
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + user.token
        },
        body: JSON.stringify({ title: title, score: score })
    })
        .then(function (response)
        {
            return response.json();
        })
        .then(function (data)
        {
            showResult(data.message, data.status || "bad");
            loadMovies();
        })
        .catch(function (error)
        {
            showResult("Something went wrong sending your rating.", "bad");
            console.log(error);
        });

    movieForm.reset();
}

function start()
{
    var params = new URLSearchParams(window.location.search);

    if (params.get("code"))
    {
        exchangeCode(params.get("code")).then(function ()
        {
            window.history.replaceState({}, document.title, REDIRECT_URI);
            showUser();
            loadMovies();
        });
    }
    else
    {
        showUser();
        loadMovies();
    }
}

loadButton.addEventListener("click", loadMovies);
loginButton.addEventListener("click", startLogin);
logoutButton.addEventListener("click", logout);
movieForm.addEventListener("submit", submitRating);

start();
