var express = require("express");
var cors = require("cors");
var crypto = require("crypto");
var { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
var { DynamoDBDocumentClient, PutCommand, ScanCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
var { CognitoJwtVerifier } = require("aws-jwt-verify");

var app = express();

app.use(cors());
app.use(express.json({ limit: "10kb" }));

var REGION = process.env.AWS_REGION || "us-east-1";
var TABLE_NAME = process.env.TABLE_NAME || "MovieRatings";
var USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
var CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";

var db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

var TITLE_PATTERN = /^[A-Za-z0-9 .,:'!?&()\-]+$/;

var verifier = null;

if (USER_POOL_ID && CLIENT_ID)
{
    verifier = CognitoJwtVerifier.create(
    {
        userPoolId: USER_POOL_ID,
        tokenUse: "id",
        clientId: CLIENT_ID
    });
}
else
{
    console.log("WARNING: COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID is not set.");
}

function cleanTitle(value)
{
    if (typeof value !== "string")
    {
        return null;
    }

    var text = value.trim().replace(/\s+/g, " ");

    if (text.length < 1 || text.length > 60)
    {
        return null;
    }

    if (!TITLE_PATTERN.test(text))
    {
        return null;
    }

    return text;
}

function cleanScore(value)
{
    var number = Number(value);

    if (!Number.isInteger(number) || number < 1 || number > 10)
    {
        return null;
    }

    return number;
}

function today()
{
    return new Date().toISOString().slice(0, 10);
}

function averageOf(items)
{
    if (items.length === 0)
    {
        return 0;
    }

    var total = 0;

    for (var i = 0; i < items.length; i++)
    {
        total = total + items[i].score;
    }

    return Math.round((total / items.length) * 10) / 10;
}

function findByUser(userId)
{
    return db.send(new QueryCommand(
    {
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId }
    }));
}

function requireLogin(request, response, next)
{
    if (!verifier)
    {
        return response.status(500).json({ message: "Login is not configured on the server." });
    }

    var header = request.headers.authorization || "";

    if (header.indexOf("Bearer ") !== 0)
    {
        return response.status(401).json({ message: "Please sign in first." });
    }

    var token = header.slice(7);

    verifier.verify(token)
        .then(function (payload)
        {
            request.user =
            {
                id: payload.sub,
                name: payload.email || payload["cognito:username"] || "user"
            };

            next();
        })
        .catch(function ()
        {
            response.status(401).json({ message: "Your session is not valid. Please sign in again." });
        });
}

function buildMessage(title, score, oldAverage, ratingCount)
{
    var difference = Math.round(Math.abs(score - oldAverage) * 10) / 10;

    if (ratingCount === 0)
    {
        return {
            status: "good",
            message: "First rating saved. " + title + " at " + score + " out of 10 is your baseline."
        };
    }

    if (score >= 9)
    {
        return {
            status: "good",
            message: "You loved " + title + ". A " + score + " sits well above your average of " + oldAverage + "."
        };
    }

    if (score > oldAverage)
    {
        return {
            status: "good",
            message: title + " scored " + score + ", which is " + difference + " above your average of " + oldAverage + "."
        };
    }

    if (score === oldAverage)
    {
        return {
            status: "normal",
            message: title + " landed exactly on your average of " + oldAverage + "."
        };
    }

    if (score <= 3)
    {
        return {
            status: "bad",
            message: "Rough one. " + title + " got a " + score + ", pulling your average down from " + oldAverage + "."
        };
    }

    return {
        status: "bad",
        message: title + " scored " + score + ", which is " + difference + " below your average of " + oldAverage + "."
    };
}

app.get("/api/movies", function (request, response)
{
    db.send(new ScanCommand({ TableName: TABLE_NAME }))
        .then(function (data)
        {
            var items = data.Items || [];

            items.sort(function (a, b)
            {
                if (a.date === b.date)
                {
                    return 0;
                }

                return a.date < b.date ? 1 : -1;
            });

            var movies = [];

            for (var i = 0; i < items.length; i++)
            {
                movies.push(
                {
                    title: items[i].title,
                    score: items[i].score,
                    date: items[i].date,
                    username: items[i].username
                });
            }

            response.json(
            {
                count: movies.length,
                average: averageOf(movies),
                movies: movies
            });
        })
        .catch(function (error)
        {
            console.log(error);
            response.status(500).json({ message: "Could not read the database." });
        });
});

app.get("/api/me", requireLogin, function (request, response)
{
    findByUser(request.user.id)
        .then(function (data)
        {
            var items = data.Items || [];

            response.json(
            {
                username: request.user.name,
                ratingCount: items.length,
                average: averageOf(items)
            });
        })
        .catch(function (error)
        {
            console.log(error);
            response.status(500).json({ message: "Could not read the database." });
        });
});

app.post("/api/movies", requireLogin, function (request, response)
{
    var title = cleanTitle(request.body.title);
    var score = cleanScore(request.body.score);

    if (title === null)
    {
        return response.status(400).json(
        {
            status: "bad",
            message: "Title must be 1 to 60 characters and use only letters, numbers, spaces and basic punctuation."
        });
    }

    if (score === null)
    {
        return response.status(400).json(
        {
            status: "bad",
            message: "Score must be a whole number from 1 to 10."
        });
    }

    findByUser(request.user.id)
        .then(function (data)
        {
            var mine = data.Items || [];
            var oldAverage = averageOf(mine);

            var item =
            {
                userId: request.user.id,
                movieId: crypto.randomUUID(),
                username: request.user.name,
                title: title,
                score: score,
                date: today()
            };

            return db.send(new PutCommand({ TableName: TABLE_NAME, Item: item }))
                .then(function ()
                {
                    response.json(buildMessage(title, score, oldAverage, mine.length));
                });
        })
        .catch(function (error)
        {
            console.log(error);
            response.status(500).json({ status: "bad", message: "Could not save to the database." });
        });
});

app.get("/", function (request, response)
{
    response.send("Movie Rating Log server is running. Try /api/movies");
});

var PORT = process.env.PORT || 3000;

app.listen(PORT, function ()
{
    console.log("Server running on port " + PORT);
});

module.exports = app;
