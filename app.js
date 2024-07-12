// This file contains the route definitions and the logic for handling requests to those routes

const express = require('express');
const axios = require('axios');
const router = express.Router();
require('dotenv').config();

// Load API key from environment variables
const TOKEN = process.env.OPENAI_API_KEY;
const assistantID = process.env.ASSISTANT_ID;
const zendeskAPIKey = process.env.ZENDESK_API_KEY;
const zendeskEmail = process.env.ZENDESK_EMAIL;
const zendeskDomain = process.env.ZENDESK_DOMAIN;

// Check if all environment variables are loaded correctly
if (!TOKEN || !assistantID || !zendeskAPIKey || !zendeskEmail || !zendeskDomain) {
    throw new Error('Missing environment variables. Please check your .env file.');
}

// Utility function to trim whitespace from all string properties of an object
function trimObjectStrings(obj) {
    const trimmedObj = {};
    for (const key in obj) {
        if (typeof obj[key] === 'string') {
            trimmedObj[key] = obj[key].trim();
        } else {
            trimmedObj[key] = obj[key];
        }
    }
    return trimmedObj;
}

// Encode the Zendesk email and API key into a base64 string for HTTP Basic Authentication
const encodedCredentials = Buffer.from(`${zendeskEmail}/token:${zendeskAPIKey}`).toString('base64');

// Set up the headers with the encoded credentials
const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${encodedCredentials}`
};

// Define a POST endpoint for '/chat'
router.post('/chat', async (req, res) => {
    try {
        // Handle the chat request
        const { ticket_id } = trimObjectStrings(req.body);
        console.log('Ticket ID:', ticket_id);

        let ticketID = ticket_id;

        // The URL for the API endpoint with the search query
        const url = `https://${zendeskDomain}.zendesk.com/api/v2/tickets/${ticketID}`;

        // Make the fetch request for ticket info
        const response = await fetch(url, { method: 'GET', headers: headers });

        // Check if the response status is OK (status in the range 200-299)
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Map the fetch request response
        const responseBody = await response.json();

        // Check if the fetch request returned a body
        if (!responseBody || typeof responseBody !== 'object') {
            throw new Error('Invalid or missing response body from the API');
        }

        // Get the ticket info from the response body
        const ticketsubject = responseBody.ticket.subject;
        const ticketDescription = responseBody.ticket.description;

        console.log('Ticket Subject:', ticketsubject);
        console.log('Ticket Description:', ticketDescription);

        let message = `Ticket Subject: ${ticketsubject}\nTicket Description: ${ticketDescription}`;

        console.log('Incoming Request Body:', req.body);

        // Part 1: Create a new thread
        console.log("Part 1: Create a new thread");
        const createThreadResponse = await axios.post('https://api.openai.com/v1/threads', {}, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TOKEN}`,
                'OpenAI-Beta': 'assistants=v2'
            }
        });
        const threadID = createThreadResponse.data.id;
        console.log('Thread ID:', threadID);

        // Part 2: Add message to thread
        console.log("Part 2: Add message to thread");
        await axios.post(`https://api.openai.com/v1/threads/${threadID}/messages`,
            JSON.stringify({
                role: 'user',
                content: message
            }),
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TOKEN}`,
                    'OpenAI-Beta': 'assistants=v2'
                }
            }
        );

        // Part 3: Create a run
        console.log("Part 3: Create a run");
        console.log(assistantID);
        const createRunResponse = await axios.post(`https://api.openai.com/v1/threads/${threadID}/runs`,
            JSON.stringify({
                assistant_id: assistantID
            }),
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TOKEN}`,
                    'OpenAI-Beta': 'assistants=v2'
                }
            }
        );
        const runID = createRunResponse.data.id;
        console.log(runID);


        // Part 4 and Part 5: Get run status and check if completed
        console.log("Part 4 and Part 5: Get run status and check if completed");
        let runStatus;
        let numChecks = 0;
        const maxChecks = 30;

        do {
            if (numChecks >= maxChecks) {
                throw new Error('Max number of checks reached, run status check aborted.');
            }
            const getRunStatusResponse = await axios.get(`https://api.openai.com/v1/threads/${threadID}/runs/${runID}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${TOKEN}`,
                    'OpenAI-Beta': 'assistants=v2'
                }
            });
            runStatus = getRunStatusResponse.data.status;
            console.log("Run Status:", runStatus);

            if (runStatus === 'completed') break;
            if (runStatus === 'failed' || runStatus === 'cancelled') {
                throw new Error(`Run failed with status: ${runStatus}`);
            }
            numChecks++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        } while (runStatus === 'in_progress' || runStatus === 'queued');

        // Part 6: Get response from thread
        console.log("Part 6: Get response from thread");
        const getMessagesResponse = await axios.get(`https://api.openai.com/v1/threads/${threadID}/messages`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TOKEN}`,
                'OpenAI-Beta': 'assistants=v2'
            }
        });
        const threadResponse = getMessagesResponse.data.data[0].content[0].text.value;
        console.log('Thread Response:', threadResponse);

        const threadResponseJSON = JSON.parse(threadResponse); // Parse JSON string

        const ticket_category = threadResponseJSON.primary;
        const ticket_subcategory = threadResponseJSON.secondary;
        console.log(ticket_category);
        console.log(ticket_subcategory);

        // Function to replace spaces with underscores
        function replaceSpacesWithUnderscores(tag) {
            return tag.replace(/ /g, '_');
        }
        // Sanitize tags
        const sanitizedCategory = replaceSpacesWithUnderscores(ticket_category);
        const sanitizedSubcategory = replaceSpacesWithUnderscores(ticket_subcategory);

        // The URL for the API endpoint to add tags
        const urlTags = `https://${zendeskDomain}.zendesk.com/api/v2/tickets/${ticketID}/tags`;
        console.log(urlTags);

        const tags = [sanitizedCategory, sanitizedSubcategory]; // Adjust based on your requirements
        const requestBody = JSON.stringify({ tags: tags });

        console.log('Request Body for Tags:', requestBody);
        
        // Make the POST request to add tags to the ticket
        const responseTags = await fetch(urlTags, {
            method: 'PUT',
            headers: headers,
            body: requestBody
        });

        console.log('Response Status:', responseTags.status);
        
        if (!responseTags.ok) {
            const errorDetails = await responseTags.json();
            console.error('Error Details:', errorDetails);
            throw new Error(`HTTP error! status: ${responseTags.status}, details: ${JSON.stringify(errorDetails)}`);
        }
        console.log('Tags successfully added.');
        
        // Return the response to the client
        // Send success response
        res.status(200).json({ success: true, message: 'Tags successfully added.' });

    } catch (error) {
        console.error('Error handling chat request:', error.message);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});

module.exports = router;
