using Newtonsoft.Json;
using UnityEngine.Scripting;
using System;
namespace LiveKit
{
    [Preserve]
    [Serializable]
    public struct PublishDataOptions
    {
        [JsonProperty("reliable")]
        public bool Reliable;
        [JsonProperty("destinationIdentities")]
        public string[] DestinationIdentities;
        [JsonProperty("topic")]
        public string Topic;
    }
}